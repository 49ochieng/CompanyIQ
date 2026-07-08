const { App } = require("@microsoft/teams.apps");
const { LocalStorage } = require("@microsoft/teams.common");
const { ManagedIdentityCredential } = require("@azure/identity");
const config = require("../config");
const { runTurn } = require("../orchestrator/orchestrator");
const { formatResponse } = require("../formatting/responseFormatter");
const { resolveUserContext } = require("../auth/userContext");
const { parseCommand, buildCommandOutcome, isSignInMessage } = require("./commands");
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

// Startup config check: everything SSO needs, so misconfiguration is visible
// immediately in the log instead of as a 400 at sign-in time.
console.log(JSON.stringify({
  event: 'startup_config',
  oauthConnectionName: config.oauthConnectionName,
  clientId: process.env.CLIENT_ID || '(not set — playground/skipAuth mode, sign-in disabled)',
  clientSecretPresent: !!process.env.CLIENT_SECRET,
  tenantIdPresent: !!process.env.TENANT_ID,
  botType: process.env.BOT_TYPE || 'MultiTenant (default)',
}));

// Start the sign-in flow; on failure, log the token service's full response
// (status + body) and tell the user plainly that sign-in is misconfigured.
async function startSignIn(send, signin, conversationKey, diag) {
  // Diagnostic: fetch the same sign-in resource the OAuth card will carry and
  // log the exact tokenExchangeResource URI the Teams client is asked to match
  // against webApplicationInfo.resource.
  if (diag && diag.api && diag.activity) {
    try {
      const state = Buffer.from(JSON.stringify({
        connectionName: config.oauthConnectionName,
        conversation: {
          activityId: diag.activity.id,
          bot: diag.activity.recipient,
          channelId: diag.activity.channelId,
          conversation: diag.activity.conversation,
          serviceUrl: diag.activity.serviceUrl,
          user: diag.activity.from,
        },
        msAppId: process.env.CLIENT_ID,
      })).toString('base64');
      const resource = await diag.api.bots.signIn.getResource({ state });
      console.log(JSON.stringify({
        event: 'signin_resource',
        conversationId: conversationKey,
        tokenExchangeUri: resource.tokenExchangeResource?.uri ?? null,
        tokenExchangeProviderId: resource.tokenExchangeResource?.providerId ?? null,
        signInLinkHost: resource.signInLink ? new URL(resource.signInLink).host : null,
      }));
    } catch (error) {
      console.log(JSON.stringify({
        event: 'signin_resource_failed',
        conversationId: conversationKey,
        status: error.response?.status ?? error.status,
        body: error.response?.data ?? null,
        message: error.message,
      }));
    }
  }

  try {
    await signin({
      oauthCardText: 'CompanyIQ needs you to sign in to use SharePoint, OneDrive, email, calendar, or tasks.',
      signInButtonText: 'Sign In',
    });
    return true;
  } catch (error) {
    console.log(JSON.stringify({
      event: 'signin_start_failed',
      conversationId: conversationKey,
      status: error.response?.status ?? error.status,
      body: error.response?.data ?? error.body ?? null,
      message: error.message,
      connectionName: config.oauthConnectionName,
      clientId: process.env.CLIENT_ID || null,
    }));
    storage.delete(`pending/${conversationKey}`);
    await send(
      "Sign-in isn't configured correctly yet. An administrator needs to check the bot's OAuth " +
      `connection ('${config.oauthConnectionName}') — details are in the bot log.`
    );
    return false;
  }
}

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
app.on('message', async ({ send, activity, signin, signout, isSignedIn, userToken, api }) => {
  const conversationKey = activity.conversation.id;
  const turnStartedAt = Date.now();

  try {
    const userContext = resolveUserContext({ isSignedIn, userToken, activity });

    // "sign in" / "login" as plain text triggers the flow directly.
    if (isSignInMessage(activity.text)) {
      if (userContext.user) {
        await send(`You're already signed in as ${userContext.user.upn || userContext.user.name}.`);
      } else {
        await startSignIn(send, signin, conversationKey, { api, activity });
      }
      return;
    }

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
      if (outcome.action === 'signin') {
        if (userContext.user) {
          await send(`You're already signed in as ${userContext.user.upn || userContext.user.name}.`);
        } else {
          await startSignIn(send, signin, conversationKey, { api, activity });
        }
        return;
      }
      if (outcome.action === 'signout') {
        await signout(config.oauthConnectionName);
        await send("You're signed out. Type `sign in` to sign in again.");
        return;
      }
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
      await startSignIn(send, signin, conversationKey, { api, activity });
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
