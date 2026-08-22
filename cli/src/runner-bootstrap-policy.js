"use strict";

/**
 * A machine that already has a supported coding runner has made its choice.
 * Yaver should wire that runner, not install competitors beside it. This is
 * especially important for existing OpenCode/BYOK setups: provider and model
 * configuration belong to OpenCode and must remain untouched.
 *
 * Fresh machines retain the existing bootstrap behaviour so the global npm
 * install still produces a usable development node.
 */
function codingRunnerBootstrapPlan(entries, commandExists) {
  const installed = entries.filter((entry) => commandExists(entry.command));
  return {
    installed,
    toInstall: installed.length > 0 ? [] : entries,
  };
}

module.exports = { codingRunnerBootstrapPlan };
