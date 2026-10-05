# @agent-hooks/agent-brain

The experience memory boundary for AI agents that operate hook compositions. It records a normalized `LifecycleEvent` alongside execution feedback, then returns relevant prior outcomes to an agent planner.

`AgentBrain` does not train or host a model. The storage interface is deliberately replaceable: a deployment can append to a durable event store and add semantic retrieval without binding the SDK to a model vendor or database.
