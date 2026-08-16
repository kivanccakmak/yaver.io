import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// Legacy grant rows are inert, but account deletion must still remove their
// tombstone data and link rows. This is cleanup only; no authorization path
// reads these tables.
export async function deleteInfraGrantArtifactsForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const hostGrants = await ctx.db
    .query("infraAccessGrants")
    .withIndex("by_hostUserId", (q) => q.eq("hostUserId", userId))
    .collect();
  const guestGrants = await ctx.db
    .query("infraAccessGrants")
    .withIndex("by_guestUserId", (q) => q.eq("guestUserId", userId))
    .collect();

  const seenGrantIds = new Set<string>();
  for (const grant of [...hostGrants, ...guestGrants]) {
    const key = grant._id.toString();
    if (seenGrantIds.has(key)) continue;
    seenGrantIds.add(key);

    const deviceLinks = await ctx.db
      .query("infraAccessGrantDevices")
      .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
      .collect();
    for (const link of deviceLinks) await ctx.db.delete(link._id);

    const machineLinks = await ctx.db
      .query("infraAccessGrantMachines")
      .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
      .collect();
    for (const link of machineLinks) await ctx.db.delete(link._id);

    await ctx.db.delete(grant._id);
  }
}
