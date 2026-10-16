import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { dayBounds, todayIn, woo, WooError } from "./woo.ts";

const TIMEZONE = process.env.STORE_TIMEZONE ?? "UTC";
const STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

// The fields a model needs, not WooCommerce's full ~80-field objects.
interface WooProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
  status: string;
  stock_status: string;
  permalink: string;
}
interface WooOrder {
  id: number;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  payment_method_title: string;
  billing: { first_name: string; last_name: string; email: string };
  line_items: { name: string; quantity: number; total: string }[];
}

const product = (p: WooProduct) => ({
  id: p.id,
  name: p.name,
  sku: p.sku,
  price: p.price,
  status: p.status,
  stock_status: p.stock_status,
  url: p.permalink,
});
const order = (o: WooOrder) => ({
  id: o.id,
  status: o.status,
  total: o.total,
  currency: o.currency,
  created: o.date_created,
  customer: `${o.billing.first_name} ${o.billing.last_name}`.trim(),
  email: o.billing.email,
  payment: o.payment_method_title,
  items: o.line_items.map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
});

/** Runs a tool body; store failures become isError results a model can act on. */
async function run(fn: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
  } catch (err) {
    const text = err instanceof WooError ? err.message : "Unexpected error in the WooCommerce MCP server";
    if (!(err instanceof WooError)) console.error(err);
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

const paging = {
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  page: z.number().int().min(1).default(1),
};

export function buildServer(): McpServer {
  const server = new McpServer({ name: "woocommerce", version: "1.0.0" });

  server.registerTool(
    "list_products",
    {
      description: "List products in the store, newest first. Optionally filter by a search term.",
      inputSchema: z.object({ search: z.string().optional(), ...paging }),
      annotations: { readOnlyHint: true },
    },
    ({ search, per_page, page }) =>
      run(async () => (await woo<WooProduct[]>("GET", "/products", { search, per_page, page })).data.map(product)),
  );

  server.registerTool(
    "create_product",
    {
      description: "Create a simple product. It is published to the storefront unless status is 'draft'.",
      inputSchema: z.object({
        name: z.string().min(1),
        regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/).describe('Price as a decimal string, e.g. "499" or "19.99"'),
        description: z.string().optional(),
        sku: z.string().optional(),
        status: z.enum(["publish", "draft"]).default("publish"),
      }),
    },
    (input) => run(async () => product((await woo<WooProduct>("POST", "/products", {}, { type: "simple", ...input })).data)),
  );

  server.registerTool(
    "list_orders",
    {
      description: `List orders, newest first. Use date="today" for orders placed today (store timezone: ${TIMEZONE}).`,
      inputSchema: z.object({
        date: z.string().optional().describe('"today" or a day as YYYY-MM-DD; omit for all dates'),
        status: z.enum(STATUSES).optional(),
        ...paging,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ date, status, per_page, page }) =>
      run(async () => {
        const day = date === "today" ? todayIn(TIMEZONE) : date;
        const { data: orders, total } = await woo<WooOrder[]>("GET", "/orders", {
          status,
          per_page,
          page,
          ...(day ? dayBounds(day) : {}),
        });
        // total counts every page, so a model is not told "20" on a day with 30 orders.
        return { date: day ?? "all", total: total ?? orders.length, page, per_page, orders: orders.map(order) };
      }),
  );

  server.registerTool(
    "get_order",
    {
      description: "Get one order by its id, including line items and customer.",
      inputSchema: z.object({ id: z.number().int().positive() }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(async () => order((await woo<WooOrder>("GET", `/orders/${id}`)).data)),
  );

  server.registerTool(
    "update_order_status",
    {
      description: "Change the status of an order.",
      inputSchema: z.object({ id: z.number().int().positive(), status: z.enum(STATUSES) }),
    },
    ({ id, status }) => run(async () => order((await woo<WooOrder>("PUT", `/orders/${id}`, {}, { status })).data)),
  );

  return server;
}
