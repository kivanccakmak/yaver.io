import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateSessionInternal } from "./auth";

export const submitSurvey = mutation({
  args: {
    tokenHash: v.string(),
    isDeveloper: v.boolean(),
    fullName: v.optional(v.string()),
    languages: v.optional(v.array(v.string())),
    experienceLevel: v.optional(v.string()),
    role: v.optional(v.string()),
    companySize: v.optional(v.string()),
    useCase: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) throw new Error("Unauthorized");

    const existing = await ctx.db
      .query("developerSurveys")
      .withIndex("by_userId", (q) => q.eq("userId", result.user._id))
      .unique();

    const data = {
      userId: result.user._id,
      isDeveloper: args.isDeveloper,
      languages: args.languages,
      experienceLevel: args.experienceLevel,
      role: args.role,
      companySize: args.companySize,
      useCase: args.useCase,
      completedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.replace(existing._id, data);
    } else {
      await ctx.db.insert("developerSurveys", data);
    }

    const userPatch: Record<string, unknown> = { surveyCompleted: true };
    if (args.fullName) {
      userPatch.fullName = args.fullName;
    }
    await ctx.db.patch(result.user._id, userPatch);
  },
});

export const getSurvey = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) return null;

    const survey = await ctx.db
      .query("developerSurveys")
      .withIndex("by_userId", (q) => q.eq("userId", result.user._id))
      .unique();

    return survey
      ? {
          completed: true,
          isDeveloper: survey.isDeveloper,
          languages: survey.languages,
          experienceLevel: survey.experienceLevel,
          role: survey.role,
          companySize: survey.companySize,
          useCase: survey.useCase,
        }
      : { completed: false };
  },
});
