const { App } = require("@microsoft/teams.apps");
const { LocalStorage } = require("@microsoft/teams.common");
const { ManagedIdentityCredential } = require("@azure/identity");
const config = require("../config");
const { runTurn } = require("../orchestrator/orchestrator");
const { formatResponse } = require("../formatting/responseFormatter");

// Create storage for conversation history
const storage = new LocalStorage();

// Keep only the most recent turns per conversation so the prompt stays bounded.
const MAX_HISTORY_TURNS = 20;

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

// Trim history to the cap without leaving an orphaned function-call exchange
// at the front (the OpenAI API rejects a function result whose call is missing).
function capHistory(messages) {
  const capped = messages.slice(-MAX_HISTORY_TURNS);
  while (
    capped.length > 0 &&
    (capped[0].role === "function" ||
      (capped[0].role === "model" && capped[0].function_calls?.length))
  ) {
    capped.shift();
  }
  return capped;
}

// Handle incoming messages
app.on('message', async ({ send, activity }) => {
  //Get conversation history, keyed by conversation ID
  const conversationKey = activity.conversation.id;
  const messages = (storage.get(conversationKey) || []).slice();

  try {
    const turnResult = await runTurn({
      text: activity.text,
      messages,
      conversationId: conversationKey,
    });

    // runTurn's ChatPrompt shares the `messages` array, so this round's turns
    // (including any function-call rounds) have been appended to it.
    storage.set(conversationKey, capHistory(messages));

    await send(formatResponse(turnResult));

  } catch (error) {
    console.error('Error processing message:', error);
    await send('Sorry, I encountered an error while processing your message.');
  }
});

module.exports = app;
