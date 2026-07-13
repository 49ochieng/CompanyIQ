// Scheduled digests: run a user's saved question on a cron schedule, as that
// user, and deliver the answer proactively to their Teams chat.
//
// HARD RULE (enforced here and tested): a digest run is STRICTLY READ-ONLY.
// runTurn is always called with actionsEnabled:false, so no action is even
// registered with the model — a digest can never send an email, message anyone,
// or trigger a flow, no matter what the data or the model says.
const cron = require("node-cron");
const config = require("../config");
const { runTurn } = require("../orchestrator/orchestrator");
const { formatResponse } = require("../formatting/responseFormatter");
const { resolveUserContext } = require("../auth/userContext");
const subscriptions = require("./subscriptions");

// "daily" → 08:00 every day. Kept tiny on purpose; a test schedule is allowed
// so a digest can be demonstrated without waiting a day.
const SCHEDULES = {
    daily: "0 8 * * *",
    hourly: "0 * * * *",
    test: "*/2 * * * *", // every 2 minutes — for verifying the flow end to end
};

const tasks = new Map(); // subscriptionId -> cron task

function cronFor(schedule) {
    return SCHEDULES[schedule];
}

function isValidSchedule(schedule) {
    return Object.prototype.hasOwnProperty.call(SCHEDULES, schedule);
}

/**
 * Run one subscription now and deliver the result.
 * @param {Object} sub The subscription record.
 * @param {{app:Object, getUserToken:Function}} deps
 */
async function runDigest(sub, deps) {
    const startedAt = Date.now();
    try {
        // Silently fetch the user's token from the Bot Framework token store —
        // no turn context needed.
        const userToken = await deps.getUserToken(sub.userObjectId, sub);

        if (!userToken) {
            console.log(
                JSON.stringify({
                    event: "digest_token_missing",
                    subscriptionId: sub.id,
                    userObjectId: sub.userObjectId,
                })
            );
            await deps.app.send(
                sub.conversationId,
                "I couldn't run your scheduled digest because your sign-in has expired. " +
                'Type "sign in" and I\'ll resume it.'
            );
            return { ok: false, reason: "token_missing" };
        }

        const userContext = resolveUserContext({
            isSignedIn: true,
            userToken,
            activity: { conversation: { id: sub.conversationId } },
        });
        userContext.getAudienceToken = (connectionName) =>
            deps.getUserToken(sub.userObjectId, sub, connectionName);

        const turnResult = await runTurn({
            text: sub.question,
            messages: [], // digests are stateless — no conversation history
            conversationId: sub.conversationId,
            context: userContext,
            // READ-ONLY: actions are never registered for a scheduled run.
            actionsEnabled: false,
        });

        const activity = formatResponse(turnResult);
        activity.text = `**Your scheduled digest** — _${sub.question}_\n\n${activity.text}`;
        await deps.app.send(sub.conversationId, activity);

        console.log(
            JSON.stringify({
                event: "digest_delivered",
                subscriptionId: sub.id,
                userObjectId: sub.userObjectId,
                toolsCalled: turnResult.toolCalls.map((c) => c.tool),
                // Proof the read-only guarantee held.
                actionsProposed: (turnResult.proposals || []).length,
                actionsExecuted: (turnResult.directActions || []).length,
                latencyMs: Date.now() - startedAt,
            })
        );
        return { ok: true };
    } catch (error) {
        console.log(
            JSON.stringify({
                event: "digest_failed",
                subscriptionId: sub.id,
                errorClass: error.code || error.name || "Error",
                latencyMs: Date.now() - startedAt,
            })
        );
        return { ok: false, reason: "error" };
    }
}

/** Schedule (or reschedule) one subscription. */
function schedule(sub, deps) {
    unschedule(sub.id);
    const expr = cronFor(sub.schedule);
    if (!expr) return false;
    const task = cron.schedule(expr, () => {
        runDigest(sub, deps).catch(() => {});
    });
    tasks.set(sub.id, task);
    return true;
}

function unschedule(subscriptionId) {
    const task = tasks.get(subscriptionId);
    if (task) {
        task.stop();
        tasks.delete(subscriptionId);
    }
}

function unscheduleAllForUser(userObjectId) {
    for (const sub of subscriptions.listAll()) {
        if (sub.userObjectId === userObjectId) {
            unschedule(sub.id);
        }
    }
}

/** Load every stored subscription and start its timer. Called at startup. */
function startAll(deps) {
    const all = subscriptions.listAll();
    let started = 0;
    for (const sub of all) {
        if (schedule(sub, deps)) started++;
    }
    console.log(JSON.stringify({ event: "digests_started", count: started }));
    return started;
}

module.exports = {
    runDigest,
    schedule,
    unschedule,
    unscheduleAllForUser,
    startAll,
    isValidSchedule,
    cronFor,
    SCHEDULES,
};
