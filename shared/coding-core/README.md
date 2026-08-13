# Shared coding runtime contract

All Yaver surfaces use the same runtime vocabulary:

- mobile: remote agent or local file/Git/LLM runtime;
- web: remote/cloud client or constrained browser workspace;
- desktop GUI: full local shell/sandbox plus remote agent;
- watch/car: status, voice, stop/retry, and approval routing;
- TV: status and review display;
- XR: rich review/edit client when the platform supports storage.

Watch, car, and TV must never receive provider or Git tokens. They send
validated commands to the phone, web, desktop, cloud, or CI runtime.
