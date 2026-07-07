const { graphFetch, AUTH_REQUIRED, logGraphCall } = require("../auth/graph");

const MAX_EVENTS = 20;
const DEFAULT_DAYS = 7;

module.exports = {
    name: "getCalendar",
    description:
        "Read the signed-in user's calendar for a date range (default: the next 7 days). " +
        "Use for questions about the user's meetings, schedule, or availability.",
    parameters: {
        type: "object",
        properties: {
            startDateTime: {
                type: "string",
                description: "Range start, ISO 8601 (e.g. 2026-07-07T00:00:00Z). Default: now.",
            },
            endDateTime: {
                type: "string",
                description: "Range end, ISO 8601. Default: 7 days from now.",
            },
        },
    },
    async handler(args, context) {
        if (!context || !context.graphToken) {
            return AUTH_REQUIRED;
        }
        const startedAt = Date.now();

        const start = args.startDateTime ? new Date(args.startDateTime) : new Date();
        const end = args.endDateTime
            ? new Date(args.endDateTime)
            : new Date(start.getTime() + DEFAULT_DAYS * 24 * 60 * 60 * 1000);
        if (isNaN(start) || isNaN(end)) {
            return { error: "validation_failed", reason: "invalid date range" };
        }

        const qs =
            `startDateTime=${encodeURIComponent(start.toISOString())}` +
            `&endDateTime=${encodeURIComponent(end.toISOString())}` +
            `&$select=subject,start,end,location,organizer,webLink` +
            `&$orderby=start/dateTime&$top=${MAX_EVENTS}`;
        const response = await graphFetch(context.graphToken, "GET", `/me/calendarView?${qs}`);

        const events = (response.value || []).slice(0, MAX_EVENTS).map((e) => ({
            subject: e.subject,
            start: e.start?.dateTime,
            end: e.end?.dateTime,
            timeZone: e.start?.timeZone,
            location: e.location?.displayName,
            organizer: e.organizer?.emailAddress?.name,
            webLink: e.webLink,
        }));

        logGraphCall(context, "getCalendar", events.length, Date.now() - startedAt);
        return { events, eventCount: events.length, range: { start: start.toISOString(), end: end.toISOString() } };
    },
};
