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
const { confirmationActivity } = require("../formatting/actionCard");
const { executeApproved, cancelApproved } = require("../actions/runner");
const subscriptions = require("../scheduler/subscriptions");
const digest = require("../scheduler/digest");
const dataSources = require("../data/sources");
const { renderTrace } = require("../formatting/trace");

// Last successful query time per source, for /sources.
const lastQueryAt = new Map();

// Last turn's execution trace per conversation, for /trace. Bounded to the most
// recent turn per conversation (overwritten each turn), so it can't grow.
const lastTrace = new Map();

// Conversation references keyed by AAD object ID, so the bot can message a
// user proactively (self-messages, scheduled digests). Populated on every
// incoming activity from a signed-in user.
const conversationRefs = new LocalStorage();

function rememberConversationRef(userContext, activity) {
  if (userContext.user && userContext.user.aadObjectId) {
    conversationRefs.set(userContext.user.aadObjectId, {
      conversationId: activity.conversation.id,
      channelId: activity.channelId,
      serviceUrl: activity.serviceUrl,
      // The Teams user id is what the token service is keyed by.
      userId: activity.from && activity.from.id,
    });
  }
}

// Proactively send text to a user's own conversation (by AAD object ID).
async function sendToUser(aadObjectId, activityLike) {
  const ref = conversationRefs.get(aadObjectId);
  if (!ref) {
    return false;
  }
  await app.send(ref.conversationId, activityLike);
  return true;
}

// Fetch a user's token OUTSIDE a turn (for scheduled digests). The Bot
// Framework token service is keyed by user id + connection, so no activity
// context is needed — verified against the installed library.
async function getUserTokenOutOfTurn(aadObjectId, sub, connectionName) {
  const ref = conversationRefs.get(aadObjectId);
  const userId = (ref && ref.userId) || (sub && sub.teamsUserId);
  if (!userId) {
    return undefined;
  }
  try {
    const res = await app.api.users.token.get({
      userId,
      channelId: (ref && ref.channelId) || (sub && sub.channelId) || 'msteams',
      connectionName: connectionName || config.oauthConnectionName,
    });
    return res && res.token;
  } catch {
    return undefined; // expired / revoked → caller asks the user to sign in again
  }
}

// Resolved lazily: `app` is declared below, so this cannot capture it at
// module-evaluation time.
const digestDeps = {
  get app() { return app; },
  getUserToken: getUserTokenOutOfTurn,
};

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

// Per-audience user tokens: the bot has one OAuth connection per downstream
// audience (graph/fabric/foundry), all exchanging the same Teams SSO
// assertion. Tools resolve a fresh token for their audience at call time.
function makeAudienceTokenGetter(api, activity, isSignedIn) {
  return async (connectionName) => {
    if (!isSignedIn) {
      return undefined; // no SSO sign-in at all yet
    }
    try {
      const res = await api.users.token.get({
        channelId: activity.channelId,
        userId: activity.from.id,
        connectionName: connectionName || config.oauthConnectionName,
      });
      return res?.token;
    } catch {
      return undefined; // no token for this audience yet → auth_required path
    }
  };
}

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

  const connectionName = (diag && diag.connectionName) || config.oauthConnectionName;
  try {
    await signin({
      connectionName,
      oauthCardText:
        connectionName === config.oauthConnectionName
          ? 'CompanyIQ needs you to sign in to use SharePoint, OneDrive, email, calendar, or tasks.'
          : `CompanyIQ needs your permission to access ${connectionName === 'fabric' ? 'Fabric data' : 'AI agents'} as you.`,
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
      connectionName,
      clientId: process.env.CLIENT_ID || null,
    }));
    storage.delete(`pending/${conversationKey}`);
    await send(
      "Sign-in isn't configured correctly yet. An administrator needs to check the bot's OAuth " +
      `connection ('${connectionName}') — details are in the bot log.`
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
async function processTurn(send, conversationKey, text, userContext, allowedTools, options = {}) {
  const messages = (storage.get(conversationKey) || []).slice();
  const turnResult = await runTurn({
    text,
    messages,
    conversationId: conversationKey,
    context: userContext,
    allowedTools,
    // Actions available only for real user turns, never for read-only
    // (command-scoped or scheduled digest) runs.
    actionsEnabled: options.actionsEnabled === true,
  });

  // Record the execution trace for /trace (even on auth-required turns — seeing
  // the tool that demanded sign-in is exactly what the user wants to inspect).
  if (turnResult.trace) {
    lastTrace.set(conversationKey, turnResult.trace);
  }

  if (turnResult.authRequired) {
    return turnResult;
  }

  storage.set(conversationKey, capHistory(messages));
  await send(formatResponse(turnResult));

  // Render a confirmation card for each proposed (confirmed) action.
  for (const proposal of turnResult.proposals || []) {
    await send(confirmationActivity(proposal.proposalId, proposal.preview));
  }

  // Execute queued no-confirmation actions (structurally safe, e.g. self-msg).
  for (const direct of turnResult.directActions || []) {
    const { executeDirect } = require("../actions/runner");
    await executeDirect(direct.name, direct.args, {
      userId: userContext.user && userContext.user.aadObjectId,
      context: userContext,
    });
  }

  return turnResult;
}

// Resolve an Approve/Cancel card click. The proposal store enforces that the
// clicking user is the proposing user and that it hasn't expired; execution
// applies the rate limit and audit trail.
async function handleCardAction(send, value, userContext) {
  const userId = userContext.user && userContext.user.aadObjectId;
  if (!userId) {
    await send("Please sign in before confirming an action.");
    return;
  }
  if (value.companyiqAction === 'cancel') {
    cancelApproved(value.proposalId, userId);
    await send("Cancelled — nothing was sent.");
    return;
  }
  const outcome = await executeApproved(value.proposalId, { userId, context: userContext });
  if (outcome.ok) {
    await send("Done ✅");
  } else if (outcome.error === 'wrong_user') {
    await send("That confirmation belongs to someone else.");
  } else if (outcome.error === 'expired' || outcome.error === 'not_found') {
    await send("That confirmation has expired. Please ask again if you still want it.");
  } else if (outcome.error === 'rate_limited') {
    await send(outcome.message);
  } else if (outcome.error === 'auth_required') {
    await send("Please sign in again to complete that action.");
  } else {
    await send("Sorry, that action could not be completed.");
  }
}

// Handle incoming messages
app.on('message', async ({ send, activity, signin, signout, isSignedIn, userToken, api }) => {
  const conversationKey = activity.conversation.id;
  const turnStartedAt = Date.now();

  try {
    const userContext = resolveUserContext({ isSignedIn, userToken, activity });
    userContext.getAudienceToken = makeAudienceTokenGetter(api, activity, isSignedIn);
    rememberConversationRef(userContext, activity);
    // Injected so the sendTeamsMessage action can only reach THIS user.
    userContext.sendToSelf = async (message) => {
      if (userContext.user && userContext.user.aadObjectId) {
        await sendToUser(userContext.user.aadObjectId, message);
      }
    };
    // Lets a slow tool (e.g. a cold database) tell the user what's happening
    // mid-turn instead of leaving them staring at nothing.
    userContext.notify = async (message) => {
      await send(message);
    };

    // Adaptive Card Approve/Cancel arrive as a message with activity.value
    // (no text). Resolve against the proposal store (user-bound + expiry).
    if (activity.value && activity.value.companyiqAction) {
      await handleCardAction(send, activity.value, userContext);
      return;
    }

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
      if (outcome.action === 'subscribe') {
        if (!digest.isValidSchedule(outcome.schedule)) {
          await send(
            `I don't know the schedule \`${outcome.schedule}\`. Try: ` +
            Object.keys(digest.SCHEDULES).map((s) => `\`${s}\``).join(', ') + '.'
          );
          return;
        }
        const sub = subscriptions.add({
          userObjectId: userContext.user.aadObjectId,
          upn: userContext.user.upn,
          teamsUserId: activity.from.id,
          channelId: activity.channelId,
          conversationId: conversationKey,
          schedule: outcome.schedule,
          question: outcome.question,
        });
        digest.schedule(sub, digestDeps);
        console.log(JSON.stringify({
          event: 'digest_subscribed',
          subscriptionId: sub.id,
          userObjectId: sub.userObjectId,
          schedule: sub.schedule,
        }));
        await send(
          `Done — I'll send you "${outcome.question}" **${outcome.schedule}**. ` +
          'Digests are read-only: they answer the question, they never take actions. `/unsubscribe` stops them.'
        );
        return;
      }
      if (outcome.action === 'sources') {
        const lines = ['**Data sources**', ''];
        for (const s of dataSources.listAll()) {
          if (!s.configured) {
            lines.push(`- **${s.name}** — not configured (missing settings), so it can't be queried.`);
            continue;
          }
          const source = dataSources.getSource(s.name);
          const probe = await source.probe(userContext);
          const health = probe.ok
            ? `✅ reachable (${probe.latencyMs}ms)`
            : `⛔ ${probe.message || probe.reason}`;
          const scoping = s.scopePolicy === 'row_predicate'
            ? 'scoped to **your** assortment (row-level predicate on every query)'
            : 'runs as **you** — Fabric enforces your own permissions';
          const last = lastQueryAt.get(s.name);
          lines.push(`- **${s.name}** — ${s.label}`);
          lines.push(`    - ${s.tableCount} tables · ${scoping}`);
          lines.push(`    - ${health}${last ? ` · last query ${last}` : ''}`);
        }
        await send(lines.join('\n'));
        return;
      }
      if (outcome.action === 'trace') {
        await send(renderTrace(lastTrace.get(conversationKey)));
        return;
      }
      if (outcome.action === 'unsubscribe') {
        digest.unscheduleAllForUser(userContext.user.aadObjectId);
        const removed = subscriptions.removeAllForUser(userContext.user.aadObjectId);
        await send(removed > 0
          ? `Stopped ${removed} scheduled digest${removed === 1 ? '' : 's'}.`
          : 'You have no scheduled digests.');
        return;
      }
      if (outcome.reply) {
        await send(outcome.reply);
        return;
      }
      activity.text = outcome.turn.text;
      commandTools = outcome.turn.allowedTools;
    }

    // Actions enabled only for free-form user turns (not command-scoped runs).
    const turnResult = await processTurn(send, conversationKey, activity.text, userContext, commandTools, {
      actionsEnabled: !commandTools,
    });

    if (turnResult.authRequired) {
      // A tool needing user identity was selected but no token exists for its
      // audience: remember the question, start the sign-in flow for THAT
      // connection, and retry on the `signin` event.
      storage.set(`pending/${conversationKey}`, activity.text);
      await startSignIn(send, signin, conversationKey, {
        api,
        activity,
        connectionName: turnResult.authRequiredConnection,
      });
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
    // A non-default connection just completed sign-in: ctx.token belongs to
    // that audience, so resolve identity from the default Graph connection.
    const graphToken = await makeAudienceTokenGetter(ctx.api, ctx.activity, true)(config.oauthConnectionName);
    const userContext = resolveUserContext({
      isSignedIn: true,
      userToken: graphToken || ctx.token.token,
      activity: ctx.activity,
    });
    userContext.getAudienceToken = makeAudienceTokenGetter(ctx.api, ctx.activity, true);

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

// Restore scheduled digests after a restart.
function startDigests() {
  return digest.startAll(digestDeps);
}

/** Record a successful query against a source (for /sources). */
function noteQuery(sourceName) {
  lastQueryAt.set(sourceName, new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z');
}

module.exports = app;
module.exports.startDigests = startDigests;
module.exports.noteQuery = noteQuery;
