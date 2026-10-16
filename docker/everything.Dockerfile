# The MCP reference server, used as a third upstream so the demo can prove that
# tools from two different servers answer one prompt. Not our code; pinned.
FROM node:24-alpine

WORKDIR /app
RUN npm install --omit=dev @modelcontextprotocol/server-everything@2026.8.31

USER node
EXPOSE 3001
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
