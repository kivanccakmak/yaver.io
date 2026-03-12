"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CONVEX_URL = "https://shocking-echidna-394.eu-west-1.convex.site";

const IDENTITIES = [
  { id: "developer", label: "Developer" },
  { id: "business", label: "Business Owner" },
  { id: "student", label: "Student / Academic" },
  { id: "other", label: "Other" },
];

const LANGUAGES = [
  "JavaScript/TypeScript", "Python", "Go", "Rust", "Java",
  "C/C++", "Ruby", "PHP", "Swift", "Kotlin", "C#", "Other",
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

const COMPANY_SIZES = [
  "Solo", "2-10", "11-50", "51-200", "201-1000", "1000+",
];

function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-3 py-2.5 text-xs font-medium transition-all ${
        selected
          ? "border-surface-500 bg-surface-800 text-surface-50"
          : "border-surface-800 text-surface-400 hover:border-surface-600 hover:text-surface-300"
      }`}
    >
      {label}
    </button>
  );
}

export default function SurveyPage() {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const [identity, setIdentity] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [experience, setExperience] = useState<string | null>(null);
  const [useCase, setUseCase] = useState<string | null>(null);
  const [companySize, setCompanySize] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isDev = identity === "developer";
  const totalPages = isDev ? 3 : 2;

  const toggleLanguage = (lang: string) => {
    setLanguages((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang]
    );
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const token = localStorage.getItem("yaver_auth_token");
      if (!token) { router.push("/auth"); return; }

      await fetch(`${CONVEX_URL}/survey/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          isDeveloper: isDev,
          languages: isDev && languages.length > 0 ? languages : undefined,
          experienceLevel: isDev ? experience : undefined,
          role: identity ?? undefined,
          companySize: companySize ?? undefined,
          useCase: useCase ?? undefined,
        }),
      });
    } catch {
      // Best effort
    }
    router.push("/dashboard");
  };

  const handleNext = () => {
    if (page === 0) {
      setPage(1);
    } else if (page === 1 && isDev) {
      setPage(2);
    } else {
      submit();
    }
  };

  const handleBack = () => setPage((p) => Math.max(0, p - 1));

  const isLastPage = isDev ? page === 2 : page === 1;

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6 py-20">
      <div className="w-full max-w-md">
        {/* Progress */}
        <div className="mb-10 flex items-center justify-center gap-2">
          {Array.from({ length: isDev ? 3 : 2 }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === page ? "w-6 bg-surface-200" : i < page ? "w-4 bg-surface-500" : "w-4 bg-surface-800"
              }`}
            />
          ))}
        </div>

        {/* Page 1: Who are you? */}
        {page === 0 && (
          <div>
            <h2 className="mb-2 text-center text-xl font-semibold tracking-tight text-surface-50">
              What best describes you?
            </h2>
            <p className="mb-8 text-center text-sm text-surface-500">
              Help us personalize your experience
            </p>
            <div className="grid grid-cols-2 gap-3">
              {IDENTITIES.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setIdentity(item.id)}
                  className={`rounded-xl border px-4 py-5 text-sm font-medium transition-all ${
                    identity === item.id
                      ? "border-surface-500 bg-surface-800 text-surface-50"
                      : "border-surface-800 text-surface-400 hover:border-surface-600 hover:text-surface-300"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Page 2 for developers: Tech stack */}
        {page === 1 && isDev && (
          <div>
            <h2 className="mb-2 text-center text-xl font-semibold tracking-tight text-surface-50">
              Your tech stack
            </h2>
            <p className="mb-6 text-center text-sm text-surface-500">
              Select all that apply
            </p>
            <div className="mb-8 flex flex-wrap gap-2">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang}
                  onClick={() => toggleLanguage(lang)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all ${
                    languages.includes(lang)
                      ? "border-surface-500 bg-surface-800 text-surface-50"
                      : "border-surface-800 text-surface-400 hover:border-surface-600"
                  }`}
                >
                  {lang}
                </button>
              ))}
            </div>

            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-surface-500">Experience</p>
            <div className="grid grid-cols-2 gap-2">
              {EXPERIENCE_LEVELS.map((level) => (
                <Chip key={level} label={level} selected={experience === level} onClick={() => setExperience(level)} />
              ))}
            </div>
          </div>
        )}

        {/* Page 2 for non-devs OR Page 3 for devs: Use case + Company */}
        {((page === 1 && !isDev) || (page === 2 && isDev)) && (
          <div>
            <h2 className="mb-2 text-center text-xl font-semibold tracking-tight text-surface-50">
              How will you use Yaver?
            </h2>
            <p className="mb-6 text-center text-sm text-surface-500">
              Almost done
            </p>

            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-surface-500">Primary use</p>
            <div className="mb-8 grid grid-cols-2 gap-2">
              {USE_CASES.map((uc) => (
                <Chip key={uc} label={uc} selected={useCase === uc} onClick={() => setUseCase(uc)} />
              ))}
            </div>

            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-surface-500">Team size</p>
            <div className="grid grid-cols-3 gap-2">
              {COMPANY_SIZES.map((size) => (
                <Chip key={size} label={size} selected={companySize === size} onClick={() => setCompanySize(size)} />
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="mt-8 flex items-center gap-3">
          {page > 0 && (
            <button
              onClick={handleBack}
              className="rounded-lg border border-surface-800 px-4 py-3 text-sm text-surface-400 transition-colors hover:border-surface-600 hover:text-surface-300"
            >
              Back
            </button>
          )}
          <button
            onClick={handleNext}
            disabled={submitting || (page === 0 && identity === null)}
            className="flex-1 rounded-lg bg-surface-100 px-4 py-3 text-sm font-medium text-surface-950 transition-colors hover:bg-surface-200 disabled:opacity-40"
          >
            {submitting ? "..." : isLastPage ? "Finish" : "Continue"}
          </button>
        </div>

        <button
          onClick={submit}
          disabled={submitting}
          className="mt-4 w-full py-2 text-center text-xs text-surface-600 transition-colors hover:text-surface-400 disabled:opacity-40"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
