@maxLength(20)
@minLength(4)
@description('Used to generate names for all resources in this file')
param resourceBaseName string

@maxLength(42)
param botDisplayName string

param botServiceName string = resourceBaseName
param botServiceSku string = 'F0'
param identityResourceId string
param identityClientId string
param identityTenantId string
param botAppDomain string
param oauthConnectionName string = 'graph'
param ssoAppClientId string = ''
@secure()
param ssoAppClientSecret string = ''
param graphScopes string = 'User.Read Sites.Read.All Files.Read.All Mail.Read Calendars.Read Tasks.Read People.Read User.ReadBasic.All'

// Register your web service as a bot with the Bot Framework
resource botService 'Microsoft.BotService/botServices@2021-03-01' = {
  kind: 'azurebot'
  location: 'global'
  name: botServiceName
  properties: {
    displayName: botDisplayName
    endpoint: 'https://${botAppDomain}/api/messages'
    msaAppId: identityClientId
    msaAppMSIResourceId: identityResourceId
    msaAppTenantId:identityTenantId
    msaAppType:'UserAssignedMSI'
  }
  sku: {
    name: botServiceSku
  }
}

// Connect the bot service to Microsoft Teams
resource botServiceMsTeamsChannel 'Microsoft.BotService/botServices/channels@2021-03-01' = {
  parent: botService
  location: 'global'
  name: 'MsTeamsChannel'
  properties: {
    channelName: 'MsTeamsChannel'
  }
}

// OAuth connections backing Teams SSO: the token service exchanges the user's
// SSO assertion for a delegated token per audience. 'graph' is the default
// connection; 'fabric' and 'foundry' carry the user's identity to Fabric data
// agents and Foundry agents (identity-propagating delegation).
var oauthConnections = [
  {
    name: oauthConnectionName
    scopes: graphScopes
  }
  {
    name: 'fabric'
    scopes: 'https://api.fabric.microsoft.com/.default'
  }
  {
    name: 'foundry'
    scopes: 'https://ai.azure.com/.default'
  }
  {
    name: 'flow'
    scopes: 'https://service.flow.microsoft.com/User'
  }
]

resource botOAuthConnections 'Microsoft.BotService/botServices/connections@2022-09-15' = [
  for connection in oauthConnections: if (!empty(ssoAppClientId)) {
    parent: botService
    location: 'global'
    name: connection.name
    properties: {
      serviceProviderDisplayName: 'Azure Active Directory v2'
      serviceProviderId: '30dd229c-58e3-4a48-bdfd-91ec48eb906c' // Aadv2
      clientId: ssoAppClientId
      clientSecret: ssoAppClientSecret
      scopes: connection.scopes
      parameters: [
        {
          key: 'tenantID'
          value: identityTenantId
        }
        {
          key: 'tokenExchangeUrl'
          // Teams bot SSO requires the resource URI to embed THIS bot's id
          // (api://botid-<botId>); the SSO app carries one such URI per bot.
          value: 'api://botid-${identityClientId}'
        }
      ]
    }
  }
]
