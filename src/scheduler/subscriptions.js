// Digest subscriptions — file-backed for local development.
//
// DEPLOY TARGET: replace the file store with Azure Table Storage (partition by
// user object id) or Cosmos DB. The interface below is deliberately small so
// only load()/save() change: an App Service instance has ephemeral local disk,
// and multiple instances would each keep their own copy.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_PATH = process.env.SUBSCRIPTIONS_PATH || path.join(__dirname, "..", "..", ".subscriptions.json");

function load() {
    try {
        return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    } catch {
        return [];
    }
}

function save(subs) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(subs, null, 2));
}

/**
 * @param {{userObjectId:string, upn?:string, question:string, schedule:string,
 *          conversationId:string, channelId?:string}} sub
 */
function add(sub) {
    const subs = load();
    // The store owns id/createdAt — a caller cannot override them.
    const record = {
        ...sub,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
    };
    subs.push(record);
    save(subs);
    return record;
}

/** Record when a subscription last ran, so a brief can diff "since last time". */
function setLastRun(id, iso) {
    const subs = load();
    const sub = subs.find((s) => s.id === id);
    if (sub) {
        sub.lastRunAt = iso;
        save(subs);
    }
}

/** Remove every subscription belonging to a user. Returns how many went. */
function removeAllForUser(userObjectId) {
    const subs = load();
    const keep = subs.filter((s) => s.userObjectId !== userObjectId);
    save(keep);
    return subs.length - keep.length;
}

function listForUser(userObjectId) {
    return load().filter((s) => s.userObjectId === userObjectId);
}

function listAll() {
    return load();
}

module.exports = { add, setLastRun, removeAllForUser, listForUser, listAll, load, save, STORE_PATH };
