#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerUiTreeTool } from "./tools/ui-tree.js";
import { registerFindAndTapTool } from "./tools/find-and-tap.js";
import { registerTapTool } from "./tools/tap.js";
import { registerTypeTextTool, registerPressKeyTool } from "./tools/input.js";
import { registerSwipeTool } from "./tools/swipe.js";
import { registerScreenshotTool } from "./tools/screenshot.js";
import { registerWaitForElementTool } from "./tools/wait.js";
import { registerDeviceTool } from "./tools/device.js";
import { registerShellTool } from "./tools/shell.js";
import { registerBatchTool } from "./tools/batch.js";

const server = new McpServer({
  name: "android-emulator-mcp",
  version: "1.0.0",
});

// Register all tools
registerUiTreeTool(server);
registerFindAndTapTool(server);
registerTapTool(server);
registerTypeTextTool(server);
registerPressKeyTool(server);
registerSwipeTool(server);
registerScreenshotTool(server);
registerWaitForElementTool(server);
registerDeviceTool(server);
registerShellTool(server);
registerBatchTool(server);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
