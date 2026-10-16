Build context for every Dockerfile here is the repo root:

    docker build -f docker/gateway.Dockerfile -t urumi/gateway:dev .

The backend images ship TypeScript sources: Node 24 strips the types at load
time, so there is no build step to go wrong between `pnpm test` and the image.
Only the dashboard is built (Vite), inside the gateway image.
