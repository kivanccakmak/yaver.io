const { withEntitlementsPlist } = require("@expo/config-plugins");

/**
 * Adds the keychain-access-groups entitlement to the tvOS (and iOS) target.
 * expo-secure-store (Keychain) fails with "required entitlement is not present"
 * on tvOS simulator without it. Kept via prebuild so it survives `expo prebuild`.
 */
module.exports = function withTvKeychain(config) {
  return withEntitlementsPlist(config, (config) => {
    const groups = config.modResults["keychain-access-groups"];
    const entry = "$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)";
    if (!Array.isArray(groups)) {
      config.modResults["keychain-access-groups"] = [entry];
    } else if (!groups.includes(entry)) {
      groups.push(entry);
    }
    return config;
  });
};
