@maxLength(20)
@minLength(4)
@description('Used to generate names for all resources in this file')
param resourceBaseName string

@secure()
param azureOpenAIKey string

param azureOpenAIEndpoint string
param azureOpenAIApiVersion string
param azureOpenAIChatDeployment string
param azureOpenAIEmbeddingDeployment string

@secure()
param azureSearchQueryKey string

param azureSearchEndpoint string
param azureSearchIndexName string

param azureSqlServer string
param azureSqlDatabase string

param azureSqlUsername string

@secure()
param azureSqlPassword string

param userScopeMap string = '{}'
param oauthConnectionName string = 'graph'
param sharePointSites string = ''
param ssoAppClientId string = ''

@secure()
param ssoAppClientSecret string = ''

param graphScopes string = ''
param mcpServers string = '[]'
param foundryAgents string = '[]'
param httpAgents string = '[]'
param fabricDataAgents string = '[]'

param webAppSKU string

@maxLength(42)
param botDisplayName string

param serverfarmsName string = resourceBaseName
param webAppName string = resourceBaseName
param identityName string = resourceBaseName
param keyVaultName string = 'kv${resourceBaseName}'
param location string = resourceGroup().location

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  location: location
  name: identityName
}

// Key Vault holds the runtime secrets; the app resolves them at startup via
// its managed identity (RBAC: Key Vault Secrets User). App settings carry
// only non-secret configuration plus KEY_VAULT_URI.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
  }
}

resource secretOpenAIKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(azureOpenAIKey)) {
  parent: keyVault
  name: 'azure-openai-api-key'
  properties: {
    value: azureOpenAIKey
  }
}

resource secretSearchQueryKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(azureSearchQueryKey)) {
  parent: keyVault
  name: 'azure-search-query-key'
  properties: {
    value: azureSearchQueryKey
  }
}

// NOTE: the SQL *username* is not a credential on its own and is supplied as a
// plain app setting (below), like the server and database names. Only the
// password lives in Key Vault.

resource secretSqlPassword 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(azureSqlPassword)) {
  parent: keyVault
  name: 'azure-sql-password'
  properties: {
    value: azureSqlPassword
  }
}

// Key Vault Secrets User
var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource kvSecretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Compute resources for your Web App
resource serverfarm 'Microsoft.Web/serverfarms@2021-02-01' = {
  kind: 'app'
  location: location
  name: serverfarmsName
  sku: {
    name: webAppSKU
  }
}

// Web App that hosts your agent
resource webApp 'Microsoft.Web/sites@2021-02-01' = {
  kind: 'app'
  location: location
  name: webAppName
  properties: {
    serverFarmId: serverfarm.id
    httpsOnly: true
    siteConfig: {
      alwaysOn: true
      appSettings: [
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1' // Run Azure App Service from a package file
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22' // Node 20 reached end-of-life April 2026
        }
        {
          name: 'RUNNING_ON_AZURE'
          value: '1'
        }
        {
          name: 'CLIENT_ID'
          value: identity.properties.clientId
        }
        {
          name: 'TENANT_ID'
          value: identity.properties.tenantId
        }
        {
          name: 'BOT_TYPE'
          value: 'UserAssignedMsi'
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVault.properties.vaultUri
        }
        {
          name: 'AZURE_OPENAI_ENDPOINT'
          value: azureOpenAIEndpoint
        }
        {
          name: 'AZURE_OPENAI_API_VERSION'
          value: azureOpenAIApiVersion
        }
        {
          name: 'AZURE_OPENAI_CHAT_DEPLOYMENT'
          value: azureOpenAIChatDeployment
        }
        {
          name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT'
          value: azureOpenAIEmbeddingDeployment
        }
        {
          name: 'AZURE_SEARCH_ENDPOINT'
          value: azureSearchEndpoint
        }
        {
          name: 'AZURE_SEARCH_INDEX_NAME'
          value: azureSearchIndexName
        }
        {
          name: 'AZURE_SQL_SERVER'
          value: azureSqlServer
        }
        {
          name: 'AZURE_SQL_DATABASE'
          value: azureSqlDatabase
        }
        {
          name: 'AZURE_SQL_USERNAME'
          value: azureSqlUsername
        }
        {
          name: 'USER_SCOPE_MAP'
          value: userScopeMap
        }
        {
          name: 'OAUTH_CONNECTION_NAME'
          value: oauthConnectionName
        }
        {
          name: 'SHAREPOINT_SITES'
          value: sharePointSites
        }
        {
          name: 'MCP_SERVERS'
          value: mcpServers
        }
        {
          name: 'FOUNDRY_AGENTS'
          value: foundryAgents
        }
        {
          name: 'HTTP_AGENTS'
          value: httpAgents
        }
        {
          name: 'FABRIC_DATA_AGENTS'
          value: fabricDataAgents
        }
        {
          name: 'DB_KEEPALIVE'
          value: 'true' // keep the serverless database resumed
        }
      ]
      ftpsState: 'FtpsOnly'
    }
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
}

// Register your web service as a bot with the Bot Framework
module azureBotRegistration './botRegistration/azurebot.bicep' = {
  name: 'Azure-Bot-registration'
  params: {
    resourceBaseName: resourceBaseName
    identityClientId: identity.properties.clientId
    identityResourceId: identity.id
    identityTenantId: identity.properties.tenantId
    botAppDomain: webApp.properties.defaultHostName
    botDisplayName: botDisplayName
    oauthConnectionName: oauthConnectionName
    ssoAppClientId: ssoAppClientId
    ssoAppClientSecret: ssoAppClientSecret
    graphScopes: empty(graphScopes)
      ? 'User.Read Sites.Read.All Files.Read.All Mail.Read Calendars.Read Tasks.Read People.Read User.ReadBasic.All'
      : graphScopes
  }
}

// The output will be persisted in .env.{envName}. Visit https://aka.ms/teamsfx-actions/arm-deploy for more details.
output BOT_AZURE_APP_SERVICE_RESOURCE_ID string = webApp.id
output BOT_DOMAIN string = webApp.properties.defaultHostName
output BOT_ID string = identity.properties.clientId
output BOT_TENANT_ID string = identity.properties.tenantId
output KEY_VAULT_URI string = keyVault.properties.vaultUri
