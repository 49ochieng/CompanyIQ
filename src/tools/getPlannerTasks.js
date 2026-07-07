const { graphFetch, AUTH_REQUIRED, logGraphCall } = require("../auth/graph");

const MAX_TASKS = 20;

module.exports = {
    name: "getPlannerTasks",
    description:
        "List the signed-in user's Microsoft Planner tasks (title, due date, completion, plan). " +
        "Use for questions about the user's assigned tasks or to-dos in Planner.",
    parameters: {
        type: "object",
        properties: {
            onlyOpen: {
                type: "boolean",
                description: "When true (default), exclude completed tasks.",
            },
        },
    },
    async handler(args, context) {
        if (!context || !context.graphToken) {
            return AUTH_REQUIRED;
        }
        const startedAt = Date.now();

        const response = await graphFetch(context.graphToken, "GET", "/me/planner/tasks");
        let tasks = response.value || [];
        if (args.onlyOpen !== false) {
            tasks = tasks.filter((t) => (t.percentComplete ?? 0) < 100);
        }
        tasks = tasks.slice(0, MAX_TASKS);

        // Resolve plan titles only for plans referenced by the returned tasks.
        const planIds = [...new Set(tasks.map((t) => t.planId).filter(Boolean))];
        const planTitles = {};
        for (const planId of planIds) {
            try {
                const plan = await graphFetch(
                    context.graphToken,
                    "GET",
                    `/planner/plans/${encodeURIComponent(planId)}?$select=title`
                );
                planTitles[planId] = plan.title;
            } catch {
                planTitles[planId] = undefined;
            }
        }

        const results = tasks.map((t) => ({
            title: t.title,
            dueDateTime: t.dueDateTime,
            percentComplete: t.percentComplete,
            planTitle: planTitles[t.planId],
        }));

        logGraphCall(context, "getPlannerTasks", results.length, Date.now() - startedAt);
        return { tasks: results, taskCount: results.length };
    },
};
