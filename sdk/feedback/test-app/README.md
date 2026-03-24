# Feedback SDK Test App

Integration tests for the Yaver feedback SDK.

## Run against local agent

```bash
# Start agent
cd desktop/agent && go run . serve --debug

# Run tests
node test-feedback.js http://localhost:18080
```

## Run with auth token

```bash
YAVER_AUTH_TOKEN=your-token node test-feedback.js
```
