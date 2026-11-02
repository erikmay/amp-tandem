// pi extension: /ask opens a confirm dialog (to test the blocked status).
export default function (pi: any) {
  pi.registerCommand("ask", { description: "ask a question", handler: async (_args: string, ctx: any) => {
    const ok = await ctx.ui.confirm("Deploy now?", "Answer yes or no");
    ctx.ui.notify(`answer: ${ok}`, "info");
  } });
}
