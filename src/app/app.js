const { App } = require("@microsoft/teams.apps");
const { ChatPrompt } = require("@microsoft/teams.ai");
const { LocalStorage } = require("@microsoft/teams.common");
const { OpenAIChatModel } = require("@microsoft/teams.openai");
const { MessageActivity, TokenCredentials } = require('@microsoft/teams.api');
const { ManagedIdentityCredential } = require('@azure/identity');
const fs = require('fs');
const path = require('path');
const config = require("../config");
const { AzureAISearchDataSource } = require("./azureAISearchDataSource");

// Create storage for conversation history
const storage = new LocalStorage();

// Keep only the most recent turns per conversation so the prompt stays bounded.
const MAX_HISTORY_TURNS = 20;

// Initialize the standalone data source
const dataSource = new AzureAISearchDataSource({
    name: "azure-ai-search",
    indexName: "my-documents",
    azureAISearchApiKey: config.azureSearchKey,
    azureAISearchEndpoint: config.azureSearchEndpoint,
    azureOpenAIApiKey: config.azureOpenAIKey,
    azureOpenAIEndpoint: config.azureOpenAIEndpoint,
    azureOpenAIEmbeddingDeploymentName: config.azureOpenAIEmbeddingDeploymentName
});

// Load instructions from file on initialization
function loadInstructions() {
  const instructionPath = path.join(__dirname, 'instructions.txt');
  return fs.readFileSync(instructionPath, 'utf-8').trim();
}

// Load instructions once at startup
const instructions = loadInstructions();

const createTokenFactory = () => {
  return async (scope, tenantId) => {
    const managedIdentityCredential = new ManagedIdentityCredential({
        clientId: process.env.CLIENT_ID
      });
    const scopes = Array.isArray(scope) ? scope : [scope];
    const tokenResponse = await managedIdentityCredential.getToken(scopes, {
      tenantId: tenantId
    });
   
    return tokenResponse.token;
  };
};

// Configure authentication using TokenCredentials
const tokenCredentials = {
  clientId: process.env.CLIENT_ID || '',
  token: createTokenFactory()
};

const credentialOptions = config.MicrosoftAppType === "UserAssignedMsi" ? { ...tokenCredentials } : undefined;

// Create the main App instance
const app = new App({
  ...credentialOptions,
  storage,
  skipAuth: !process.env.CLIENT_ID,
});

// Handle incoming messages
app.on('message', async ({ send, activity }) => {
  //Get conversation history, keyed by conversation ID
  const conversationKey = activity.conversation.id;
  const messages = (storage.get(conversationKey) || []).slice();

  try {
    // Get relevant context from the data source
    const contextData = await dataSource.renderContext(activity.text);
    
    // Build enhanced instructions that include context if available
    let enhancedInstructions = instructions;
    if (contextData) {
      enhancedInstructions += `\n\nAdditional Context \n${contextData}`;
    }

    const prompt = new ChatPrompt({
      messages,
      instructions: enhancedInstructions,
      model: new OpenAIChatModel({
        model: config.azureOpenAIDeploymentName,
        apiKey: config.azureOpenAIKey,
        endpoint: config.azureOpenAIEndpoint,
        apiVersion: "2024-10-21"
      })
    });

    const response = await prompt.send(activity.text);

    // ChatPrompt wraps `messages` in a LocalMemory that shares the array, so
    // send() has already appended this round's user turn and assistant reply.
    storage.set(conversationKey, messages.slice(-MAX_HISTORY_TURNS));

    // Create response with AI generated indicator and add citations if we used context
    let result = null;
    
    try {
      result = JSON.parse(response.content);
    } catch (error) {
      console.error(`Response is not valid json, using raw text. error: ${error}`);
      await send(response.content);
      return;
    }

    // Process citations if they exist in the parsed response
    const citations = [];
    let position = 1;
    let content = "";

    if (result && result.results && result.results.length > 0) {
      result.results.forEach((contentItem) => {
        if (contentItem.citationTitle ) {
          const citation = {
            name: contentItem.citationTitle || `Document #${position}`,
            abstract: contentItem.citationContent ?? `Information from ${contentItem.citationTitle}`,
          };
          
         content += `${contentItem.answer}[${position}]<br>`;
          
          position++;
          citations.push(citation);
        } else {
          // Add content without citation
          content += `${contentItem.answer}<br>`;
        }
      });
    }
    
    const responseActivity = new MessageActivity(content).addAiGenerated();
    
    // Add citations from parsed response or fallback to context sources
    if (citations.length > 0) {
      citations.forEach((citation, index) => {
        responseActivity.addCitation(index + 1, {
          name: citation.name,
          abstract: `${citation.abstract}`
        });
      });
    } 
    
    await send(responseActivity);

  } catch (error) {
    console.error('Error processing message:', error);
    await send('Sorry, I encountered an error while processing your message.');
  }
});

module.exports = app;