# Luna Postman Public Workspace

This folder contains the files needed for the required public Postman workspace:

- `soa-clean.postman_collection.json`: REST, GraphQL, and gRPC test documentation with saved example responses.
- `soa-clean.postman_environment.json`: hosted Railway environment variables.

Created Postman workspace:

```text
https://go.postman.co/workspace/22e3bdad-1779-4c8a-95cc-4ce0008eba21
```

The collection and environment have been uploaded there. If Postman still shows it as a team/internal workspace, change the workspace type to `Public` in Postman's UI before submitting the link.

## Import And Use

1. Open Postman.
2. Create or open a public workspace named `Luna SOA Public Tests`.
3. Click `Import`.
4. Import both JSON files from this folder.
5. Select the `Luna SOA Hosted` environment.
6. Run `00 - Start Here / Health Check`.
7. Run `00 - Start Here / Record Test Log`.
8. Run `02 - GraphQL Tests / Dashboard Query`.

The REST and GraphQL smoke tests work against the hosted Railway API without a provider key.

## Provider Chat Tests

Before running `03 - Provider Chat Tests`, set these environment variables in Postman:

| Variable | Value |
| --- | --- |
| `providerBaseUrl` | OpenAI-compatible base URL, for example `https://api.openai.com/v1` |
| `providerApiKey` | Your real provider API key |
| `model` | A model available to that key |

## gRPC Tests

Railway gRPC service addresses are private and cannot be called directly from public Postman. For real gRPC calls, run the project locally, then use Postman's gRPC tab:

| Service | Address | Method examples |
| --- | --- | --- |
| `simplechat.v1.ChatService` | `localhost:5102` | `SendMessage` |
| `simplechat.v1.ModelService` | `localhost:5103` | `ListModels`, `Generate` |
| `simplechat.v1.ActivityService` | `localhost:5104` | `ListLogs`, `RecordLog`, `GetUsage` |

Import this proto file in Postman's gRPC tab:

```text
backend/proto/platform.proto
```

The collection includes gRPC body examples and saved example responses in the `04 - gRPC Tests To Create In Postman` folder.

## Publish Public Link

To satisfy the assignment text, the workspace must be public in your Postman account.

1. Open `https://go.postman.co/workspace/22e3bdad-1779-4c8a-95cc-4ce0008eba21`.
2. Go to `Overview`.
3. Click `Settings`.
4. Under `Workspace type`, choose `Public`.
5. Click `Save Changes` or `Submit Request` if Postman asks for approval.
6. Copy the public workspace URL.
7. Submit that URL as: `Collection publique de tests Postman`.

If you want me to publish it through the Postman API from this machine, provide a Postman API key with permission to create workspaces and collections.
