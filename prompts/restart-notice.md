The console was restarted. Your own session was resumed with its context. The agents of the project have no process now and no quota is spent on them.

Dormant agents (they wake by themselves when work arrives for them, for example a review result or a merge conflict, or when the user opens them; you can also wake one explicitly with mcp__andromeda-mcp__resume_agent {names}):
{dormant}

Interrupted agents (they need a decision from you):
{interrupted}

Stopped agents (budget, loop or usage limit; they restart through their own flow, not by waking):
{stopped}

Tickets repaired because their reviewer or recovery session did not survive the restart (they wait again as before):
{repaired}

Check the project with mcp__andromeda-mcp__list_agents before deciding anything. Do not wake everything at once: wake only what the user still wants.
