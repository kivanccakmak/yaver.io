import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/context/AuthContext";
import { useColors } from "../src/context/ThemeContext";
import { submitSurvey, getAiRunners, saveUserSettings, type AiRunner } from "../src/lib/auth";

const IDENTITIES = [
  { id: "developer", label: "Developer" },
  { id: "business", label: "Business Owner" },
  { id: "student", label: "Student / Academic" },
  { id: "other", label: "Other" },
];

const LANGUAGES = [
  "JavaScript/TypeScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "C/C++",
  "Ruby",
  "PHP",
  "Swift",
  "Kotlin",
  "C#",
  "Other",
];

const EXPERIENCE_LEVELS = ["Junior", "Mid-Level", "Senior", "Staff/Lead"];

const USE_CASES = [
  "Work / Business",
  "Hobby Projects",
  "Academic / Research",
  "Open Source",
  "Freelance / Consulting",
  "Other",
];

const COMPANY_SIZES = ["Solo", "2-10", "11-50", "51-200", "201-1000", "1000+"];

export default function SurveyScreen() {
  const { token, user, markSurveyCompleted, refreshUser } = useAuth();
  const c = useColors();

  const [page, setPage] = useState(0);
  const [fullName, setFullName] = useState(user?.name ?? "");
  const [identity, setIdentity] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [experience, setExperience] = useState<string | null>(null);
  const [useCase, setUseCase] = useState<string | null>(null);
  const [companySize, setCompanySize] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runners, setRunners] = useState<AiRunner[]>([]);
  const [selectedRunner, setSelectedRunner] = useState<string>("claude");
  const [customCommand, setCustomCommand] = useState("");

  useEffect(() => {
    getAiRunners().then((r) => {
      setRunners(r);
      const defaultRunner = r.find((runner) => runner.isDefault);
      if (defaultRunner) setSelectedRunner(defaultRunner.runnerId);
    });
  }, []);

  const isDev = identity === "developer";
  const totalPages = isDev ? 5 : 4;

  const toggleLanguage = (lang: string) => {
    setLanguages((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang]
    );
  };

  const finishSurvey = async () => {
    if (!token) return;
    setIsSubmitting(true);
    try {
      await submitSurvey(token, {
        isDeveloper: isDev,
        fullName: fullName.trim() || undefined,
        languages: isDev && languages.length > 0 ? languages : undefined,
        experienceLevel: isDev ? experience ?? undefined : undefined,
        role: identity ?? undefined,
        companySize: companySize ?? undefined,
        useCase: useCase ?? undefined,
      });
      // Save runner preference to user settings
      const runnerSettings: { runnerId: string; customRunnerCommand?: string } = { runnerId: selectedRunner };
      if (selectedRunner === "custom" && customCommand.trim()) {
        runnerSettings.customRunnerCommand = customCommand.trim();
      }
      await saveUserSettings(token, runnerSettings);
      markSurveyCompleted();
      await refreshUser();
      router.replace("/(tabs)/tasks");
    } catch {
      Alert.alert("Error", "Failed to submit survey. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNext = () => {
    if (page < totalPages - 1) {
      setPage(page + 1);
    } else {
      finishSurvey();
    }
  };

  const handleBack = () => setPage((p) => Math.max(0, p - 1));

  const isLastPage = page === totalPages - 1;

  // Map visual dot index
  const currentDot = page;
  const dotCount = totalPages;

  const renderNamePage = () => (
    <View style={styles.pageContent}>
      <Text style={[styles.pageTitle, { color: c.textPrimary }]}>
        How can we call you?
      </Text>
      <Text style={[styles.pageSubtitle, { color: c.textSecondary }]}>
        Let's get to know each other
      </Text>

      <TextInput
        style={[styles.nameInput, { backgroundColor: c.bgCard, borderColor: c.border, color: c.textPrimary }]}
        placeholder="Your name"
        placeholderTextColor={c.textMuted}
        value={fullName}
        onChangeText={setFullName}
        autoCapitalize="words"
        autoCorrect={false}
        autoFocus
      />

      <Pressable
        style={({ pressed }) => [
          styles.inlineContinue,
          { backgroundColor: c.textPrimary },
          pressed && { opacity: 0.7 },
          !fullName.trim() && { opacity: 0.4 },
        ]}
        onPress={handleNext}
        disabled={!fullName.trim()}
      >
        <Text style={[styles.nextButtonText, { color: c.bg }]}>Continue</Text>
      </Pressable>
    </View>
  );

  const renderRolePage = () => (
    <View style={styles.pageContent}>
      <Text style={[styles.pageTitle, { color: c.textPrimary }]}>
        What best describes you?
      </Text>
      <Text style={[styles.pageSubtitle, { color: c.textSecondary }]}>
        Help us personalize your experience
      </Text>

      <View style={styles.identityGrid}>
        {IDENTITIES.map((item) => {
          const selected = identity === item.id;
          return (
            <Pressable
              key={item.id}
              style={({ pressed }) => [
                styles.identityButton,
                {
                  backgroundColor: selected ? c.accent : c.bgCard,
                  borderColor: selected ? c.accent : c.border,
                },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => setIdentity(item.id)}
            >
              <Text
                style={[
                  styles.identityButtonText,
                  { color: selected ? "#fff" : c.textPrimary },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const renderRunnerPage = () => (
    <ScrollView
      contentContainerStyle={styles.pageContent}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.pageTitle, { color: c.textPrimary }]}>
        Choose your AI agent
      </Text>
      <Text style={[styles.pageSubtitle, { color: c.textSecondary }]}>
        Yaver runs any terminal AI tool on your machine
      </Text>

      <View style={styles.identityGrid}>
        {runners.map((runner) => {
          const selected = selectedRunner === runner.runnerId;
          return (
            <Pressable
              key={runner.runnerId}
              style={({ pressed }) => [
                styles.identityButton,
                {
                  backgroundColor: selected ? c.accent : c.bgCard,
                  borderColor: selected ? c.accent : c.border,
                },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => setSelectedRunner(runner.runnerId)}
            >
              <Text
                style={[
                  styles.identityButtonText,
                  { color: selected ? "#fff" : c.textPrimary },
                ]}
              >
                {runner.name}
              </Text>
              <Text
                style={[
                  styles.runnerDescText,
                  { color: selected ? "rgba(255,255,255,0.7)" : c.textMuted },
                ]}
              >
                {runner.description}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {selectedRunner === "custom" && (
        <TextInput
          style={[styles.nameInput, { backgroundColor: c.bgCard, borderColor: c.border, color: c.textPrimary, marginTop: 16 }]}
          placeholder="e.g. my-ai-tool --auto {prompt}"
          placeholderTextColor={c.textMuted}
          value={customCommand}
          onChangeText={setCustomCommand}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      <Text style={[styles.runnerHint, { color: c.textMuted }]}>
        You can change this anytime in Settings
      </Text>
    </ScrollView>
  );

  const renderPage1Dev = () => (
    <ScrollView
      contentContainerStyle={styles.pageContent}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.pageTitle, { color: c.textPrimary }]}>
        Your tech stack
      </Text>
      <Text style={[styles.pageSubtitle, { color: c.textSecondary }]}>
        Select all that apply
      </Text>
      <View style={styles.chipContainer}>
        {LANGUAGES.map((lang) => {
          const selected = languages.includes(lang);
          return (
            <Pressable
              key={lang}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: selected ? c.accent : c.bgCard,
                  borderColor: selected ? c.accent : c.border,
                },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => toggleLanguage(lang)}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: selected ? "#fff" : c.textPrimary },
                ]}
              >
                {lang}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text
        style={[styles.sectionLabel, { color: c.textSecondary, marginTop: 28 }]}
      >
        EXPERIENCE
      </Text>
      <View style={styles.optionGroup}>
        {EXPERIENCE_LEVELS.map((level) => {
          const selected = experience === level;
          return (
            <Pressable
              key={level}
              style={({ pressed }) => [
                styles.optionButton,
                {
                  backgroundColor: selected ? c.accent : c.bgCard,
                  borderColor: selected ? c.accent : c.border,
                },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => setExperience(level)}
            >
              <Text
                style={[
                  styles.optionText,
                  { color: selected ? "#fff" : c.textPrimary },
                ]}
              >
                {level}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );

  const renderUseCasePage = () => (
    <ScrollView
      contentContainerStyle={styles.pageContent}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.pageTitle, { color: c.textPrimary }]}>
        How will you use Yaver?
      </Text>
      <Text style={[styles.pageSubtitle, { color: c.textSecondary }]}>
        Almost done
      </Text>

      <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
        PRIMARY USE
      </Text>
      <View style={styles.optionGroup}>
        {USE_CASES.map((uc) => {
          const selected = useCase === uc;
          return (
            <Pressable
              key={uc}
              style={({ pressed }) => [
                styles.optionButton,
                {
                  backgroundColor: selected ? c.accent : c.bgCard,
                  borderColor: selected ? c.accent : c.border,
                },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => setUseCase(uc)}
            >
              <Text
                style={[
                  styles.optionText,
                  { color: selected ? "#fff" : c.textPrimary },
                ]}
              >
                {uc}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text
        style={[styles.sectionLabel, { color: c.textSecondary, marginTop: 28 }]}
      >
        TEAM SIZE
      </Text>
      <View style={styles.companySizeGrid}>
        {COMPANY_SIZES.map((size) => {
          const selected = companySize === size;
          return (
            <Pressable
              key={size}
              style={({ pressed }) => [
                styles.companySizeButton,
                {
                  backgroundColor: selected ? c.accent : c.bgCard,
                  borderColor: selected ? c.accent : c.border,
                },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => setCompanySize(size)}
            >
              <Text
                style={[
                  styles.optionText,
                  { color: selected ? "#fff" : c.textPrimary },
                ]}
              >
                {size}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: c.bg }]}>
      {/* Progress dots */}
      <View style={styles.dotsContainer}>
        {Array.from({ length: dotCount }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                width: i === currentDot ? 24 : 16,
                backgroundColor:
                  i === currentDot
                    ? c.textPrimary
                    : i < currentDot
                      ? c.textSecondary
                      : c.border,
              },
            ]}
          />
        ))}
      </View>

      {/* Page content */}
      <View style={styles.contentArea}>
        {page === 0 && renderNamePage()}
        {page === 1 && renderRolePage()}
        {page === 2 && renderRunnerPage()}
        {page === 3 && isDev && renderPage1Dev()}
        {((page === 3 && !isDev) || (page === 4 && isDev)) &&
          renderUseCasePage()}
      </View>

      {/* Bottom buttons — hidden on name page (page 0) since it has inline Continue */}
      {page > 0 && <View style={styles.bottomButtons}>
        {page > 0 ? (
          <Pressable
            style={({ pressed }) => [
              styles.backButton,
              { borderColor: c.border },
              pressed && { opacity: 0.7 },
            ]}
            onPress={handleBack}
          >
            <Text style={[styles.backButtonText, { color: c.textSecondary }]}>
              Back
            </Text>
          </Pressable>
        ) : (
          <View />
        )}

        <Pressable
          style={({ pressed }) => [
            styles.nextButton,
            { backgroundColor: c.textPrimary },
            pressed && { opacity: 0.7 },
            (isSubmitting || (page === 0 && !fullName.trim()) || (page === 1 && identity === null) || (page === 2 && selectedRunner === "custom" && !customCommand.trim())) && {
              opacity: 0.4,
            },
          ]}
          onPress={handleNext}
          disabled={isSubmitting || (page === 0 && !fullName.trim()) || (page === 1 && identity === null) || (page === 2 && selectedRunner === "custom" && !customCommand.trim())}
        >
          <Text style={[styles.nextButtonText, { color: c.bg }]}>
            {isSubmitting ? "..." : isLastPage ? "Finish" : "Continue"}
          </Text>
        </Pressable>
      </View>}

      {/* Only show skip after runner page (page 2) has been passed */}
      {page >= 3 && (
        <Pressable
          style={({ pressed }) => [pressed && { opacity: 0.7 }]}
          onPress={finishSurvey}
          disabled={isSubmitting}
        >
          <Text
            style={[
              styles.skipText,
              { color: c.textMuted },
              isSubmitting && { opacity: 0.4 },
            ]}
          >
            Skip for now
          </Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  dotsContainer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingTop: 16,
    paddingBottom: 8,
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },
  contentArea: {
    flex: 1,
  },
  pageContent: {
    paddingHorizontal: 24,
    paddingTop: 32,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 6,
    textAlign: "center",
    letterSpacing: -0.3,
  },
  pageSubtitle: {
    fontSize: 14,
    marginBottom: 28,
    textAlign: "center",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    marginBottom: 12,
  },
  nameInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 15,
    marginBottom: 20,
  },
  inlineContinue: {
    alignSelf: "flex-end",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
  },
  identityGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  identityButton: {
    width: "47%",
    paddingVertical: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  identityButtonText: {
    fontSize: 15,
    fontWeight: "600",
  },
  runnerDescText: {
    fontSize: 11,
    marginTop: 4,
    textAlign: "center",
  },
  runnerHint: {
    fontSize: 12,
    textAlign: "center",
    marginTop: 20,
  },
  chipContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "500",
  },
  optionGroup: {
    gap: 8,
  },
  optionButton: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  optionText: {
    fontSize: 14,
    fontWeight: "500",
  },
  companySizeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  companySizeButton: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    width: "31%",
    alignItems: "center",
  },
  bottomButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  backButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: "500",
  },
  nextButton: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
  },
  nextButtonText: {
    fontSize: 14,
    fontWeight: "600",
  },
  skipText: {
    fontSize: 13,
    fontWeight: "500",
    textAlign: "center",
    paddingBottom: 12,
  },
});
