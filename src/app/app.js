const { App } = require("@microsoft/teams.apps");
const { LocalStorage } = require("@microsoft/teams.common");
const { ManagedIdentityCredential } = require("@azure/identity");
const config = require("../config");
const { runTurn } = require("../orchestrator/orchestrator");
const { formatResponse } = require("../formatting/responseFormatter");
const { resolveUserContext } = require("../auth/userContext");
const { parseCommand, buildCommandOutcome } = require("./commands");
const { connectorStatus } = require("../connectors");
const { getTools } = require("../tools");

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
  // SSO via the Azure Bot OAuth connection; the Bot Framework Token Service
  // exchanges the Teams SSO token for a delegated Graph token (user's own
  // permissions — never app-only).
  oauth: { defaultConnectionName: config.oauthConnectionName },
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

// Run one question through the orchestrator and send the formatted reply.
// Skips persistence/reply when sign-in is required (caller handles that).
async function processTurn(send, conversationKey, text, userContext, allowedTools) {
  const messages = (storage.get(conversationKey) || []).slice();
  const turnResult = await runTurn({
    text,
    messages,
    conversationId: conversationKey,
    context: userContext,
    allowedTools,
  });

  if (turnResult.authRequired) {
    return turnResult;
  }

  // runTurn's ChatPrompt shares the `messages` array, so this round's turns
  // (including any function-call rounds) have been appended to it.
  storage.set(conversationKey, capHistory(messages));
  await send(formatResponse(turnResult));
  return turnResult;
}

// Handle incoming messages
app.on('message', async ({ send, activity, signin, isSignedIn, userToken }) => {
  const conversationKey = activity.conversation.id;
  const turnStartedAt = Date.now();

  try {
    const userContext = resolveUserContext({ isSignedIn, userToken, activity });

    // Slash commands short-circuit the orchestrator (unknown ones get help,
    // not AF-1); command turns run with a restricted tool set.
    const parsed = parseCommand(activity.text);
    let commandTools;
    if (parsed) {
      const outcome = buildCommandOutcome(parsed, {
        userContext,
        isSignedIn,
        connectorStatus,
        toolNames: getTools().map((t) => t.name),
      });
      if (outcome.reply) {
        await send(outcome.reply);
        return;
      }
      activity.text = outcome.turn.text;
      commandTools = outcome.turn.allowedTools;
    }

    const turnResult = await processTurn(send, conversationKey, activity.text, userContext, commandTools);

    if (turnResult.authRequired) {
      // A Graph tool was selected but the user has no token: remember the
      // question, start the sign-in flow, and retry on the `signin` event.
      storage.set(`pending/${conversationKey}`, activity.text);
      try {
        await signin({
          oauthCardText: 'CompanyIQ needs you to sign in to search SharePoint, OneDrive, or email.',
          signInButtonText: 'Sign In',
        });
      } catch (error) {
        console.error('Sign-in flow unavailable:', error.message);
        storage.delete(`pending/${conversationKey}`);
        await send(
          'That question needs SharePoint, OneDrive, or email access, which requires sign-in — ' +
          'available only when chatting with CompanyIQ in Microsoft Teams.'
        );
      }
    }
  } catch (error) {
    console.log(JSON.stringify({
      event: 'turn_error',
      conversationId: conversationKey,
      errorClass: error.code || error.name || 'Error',
      latencyMs: Date.now() - turnStartedAt,
    }));
    console.error('Error processing message:', error);
    await send('Sorry, I encountered an error while processing your message.');
  }
});

// Fires when the OAuth-connection sign-in completes (silent SSO token
// exchange or interactive fallback); retry the question that triggered it.
app.event('signin', async (ctx) => {
  const conversationKey = ctx.activity.conversation.id;
  const pending = storage.get(`pending/${conversationKey}`);

  try {
    const userContext = resolveUserContext({
      isSignedIn: true,
      userToken: ctx.token.token,
      activity: ctx.activity,
    });

    if (pending) {
      storage.delete(`pending/${conversationKey}`);
      await processTurn(ctx.send, conversationKey, pending, userContext);
    } else {
      await ctx.send("You're signed in.");
    }
  } catch (error) {
    console.error('Error completing sign-in turn:', error);
    await ctx.send('Sorry, I encountered an error after sign-in. Please ask your question again.');
  }
});

module.exports = app;
