/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { allQuestions } from "@/data/questions";
import { useUser, db as webDb } from "@/lib/firebase";
import Editor, { loader } from "@monaco-editor/react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// Configure Monaco editor
if (typeof window !== "undefined") {
  loader.init().then((monaco) => {
    monaco.editor.defineTheme("customTheme", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "008000" },
        { token: "keyword", foreground: "0000FF" },
        { token: "string", foreground: "A31515" },
        { token: "number", foreground: "098658" },
        { token: "type", foreground: "267F99" },
        { token: "default", foreground: "000000" },
      ],
      colors: {
        "editor.background": "#f3f4f6",
        "editor.foreground": "#000000",
        "editor.lineHighlightBackground": "#e5e7eb",
        "editor.selectionBackground": "#d1d5db",
        "editor.inactiveSelectionBackground": "#e5e7eb",
        "editor.lineHighlightBorder": "#e5e7eb",
        "editorLineNumber.foreground": "#6B7280",
        "editorLineNumber.activeForeground": "#374151",
      },
    });
  });
}

const TIMEOUT_MS = 3000;
function withTimeout<T>(p: Promise<T>) {
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("⏰ Time limit exceeded")), TIMEOUT_MS)
  );
  return Promise.race([p, timeout]) as Promise<T>;
}

type TestCase = { input: string; output: string; hidden: boolean };

interface CodeRunnerProps {
  questionId: string;
  tests: TestCase[];
}

export default function CodeRunner({ questionId, tests }: CodeRunnerProps) {
  const user = useUser();
  const [code, setCode] = useState("");
  const [output, setOutput] = useState<string>("");
  const [pyodide, setPyodide] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const [nextId, setNextId] = useState<string | null>(null);
  const [prevId, setPrevId] = useState<string | null>(null);
  const [solvedMap, setSolvedMap] = useState<Record<string, boolean>>({});
  const [levelIds, setLevelIds] = useState<string[]>([]);

  // 1) Load & initialize Pyodide v0.27.5
  useEffect(() => {
    async function init() {
      // Inject script if needed
      if (!(window as any).loadPyodide) {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js";
        await new Promise<void>((res) => {
          script.onload = () => res();
          document.body.appendChild(script);
        });
      }
      const py = await (window as any).loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/",
      });
      setPyodide(py);
      setLoading(false);
      console.log("✅ Pyodide ready", py.version);
    }
    init();
  }, []);

  useEffect(() => {
    // Derive current level and numeric code from questionId: "easy-100" → ["easy","100"]
    const [level] = questionId.split("-");

    // Define the level order
    const levels = ["easy", "medium", "hard"];

    // Get all questions for the current level
    const levelQuestions = allQuestions.filter((q) => q.level === level);
    const ids = levelQuestions.map((q) => q.id);
    setLevelIds(ids);

    const idx = ids.indexOf(questionId);

    // Compute previous question
    if (idx > 0) {
      // just the previous in this level
      setPrevId(ids[idx - 1]);
    } else {
      // first in this level → go to last of prior level (if any)
      const prevLevel = levels[levels.indexOf(level) - 1];
      if (prevLevel) {
        const prevIds = allQuestions
          .filter((q) => q.level === prevLevel)
          .map((q) => q.id);
        setPrevId(prevIds.length ? prevIds[prevIds.length - 1] : null);
      } else {
        setPrevId(null);
      }
    }

    // Compute next question
    if (idx >= 0 && idx < ids.length - 1) {
      // simply next in same level
      setNextId(ids[idx + 1]);
      return;
    }
    // else no more in this level → find next level
    const nextLevel = levels[levels.indexOf(level) + 1];
    if (nextLevel) {
      const nextIds = allQuestions
        .filter((q) => q.level === nextLevel)
        .map((q) => q.id);
      if (nextIds.length) {
        setNextId(nextIds[0]);
        return;
      }
    }

    // nowhere to go
    setNextId(null);
  }, [questionId]);

  useEffect(() => {
    if (!user?.uid) return;
    const userRef = doc(webDb, "users", user.uid);
    getDoc(userRef).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setSolvedMap(data.solved || {});
      }
    });
  }, [user]);

  const runCode = async (testCase: TestCase, question: any) => {
    // Set up sys.stdout and sys.stderr in JS before running user code
    await withTimeout(
      pyodide.runPythonAsync(
        `import sys, io; sys.stdout = io.StringIO(); sys.stderr = sys.stdout`
      )
    );

    const input = testCase.input;
    const inputFormat = question.input_format;

    // Handle different input formats
    let inputProcessor: () => string;

    if (inputFormat === "single_integer" || inputFormat === "single_string") {
      // For single value inputs, just return the input as is
      let inputValue = input;
      inputProcessor = () => {
        const value = inputValue;
        inputValue = ""; // Clear after first use
        return value;
      };
    } else if (inputFormat === "space_separated_integers") {
      // Split space-separated integers and return one at a time
      const numbers = input.split(/\s+/).filter(Boolean);
      let index = 0;
      inputProcessor = () => {
        if (index < numbers.length) {
          return numbers[index++];
        }
        throw new Error("No more input values available");
      };
    } else if (inputFormat === "multiline_integers") {
      // For multiline input, handle each line separately
      const lines = input.split(/\r?\n/).filter(Boolean);
      let lineIndex = 0;
      let currentLineNumbers: string[] = [];
      let numberIndex = 0;

      inputProcessor = () => {
        // If we have numbers from current line, return the next one
        if (numberIndex < currentLineNumbers.length) {
          return currentLineNumbers[numberIndex++];
        }

        // Get next line
        if (lineIndex < lines.length) {
          const line = lines[lineIndex++];
          // Split line into numbers if it contains multiple values
          currentLineNumbers = line.split(/\s+/).filter(Boolean);
          numberIndex = 0;
          return currentLineNumbers[numberIndex++];
        }

        throw new Error("No more input values available");
      };
    } else if (inputFormat === "space_separated_with_operator") {
      // For calculator-style input (like "5 + 3"), split into parts
      const parts = input.split(/\s+/).filter(Boolean);
      let index = 0;
      inputProcessor = () => {
        if (index < parts.length) {
          return parts[index++];
        }
        throw new Error("No more input values available");
      };
    } else {
      // Default fallback: split on whitespace or newlines
      const values = input.split(/[\s\n]+/).filter(Boolean);
      let index = 0;
      inputProcessor = () => {
        if (index < values.length) {
          return values[index++];
        }
        throw new Error("No more input values available");
      };
    }

    pyodide.globals.set("input", inputProcessor);

    // Run user code and capture output
    try {
      await withTimeout(pyodide.runPythonAsync(code));
      let rawActualOutput = await pyodide.runPythonAsync(
        "sys.stdout.getvalue()"
      );
      if (typeof rawActualOutput !== "string")
        rawActualOutput = String(rawActualOutput);
      return rawActualOutput.trim() || "[no output]";
    } catch (err: unknown) {
      // Return error output if code fails
      const errOut = await pyodide.runPythonAsync("sys.stdout.getvalue()");
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(errOut || errorMessage);
    }
  };

  // Modify handleRun to use the new runCode function
  const handleRun = async () => {
    console.log("🔘 Run clicked");
    if (loading || !pyodide) {
      console.warn("⚠️ Pyodide loading…");
      return;
    }
    try {
      setOutput("");
      const question = allQuestions.find((q) => q.id === questionId);
      if (!question) {
        throw new Error("Question not found");
      }

      const rawActualOutput = await runCode(tests[0], question);

      // Use normalized values for comparison
      const normalizedExpected = tests[0].output.trim().toLowerCase();
      const normalizedActual = rawActualOutput.trim().toLowerCase();
      let passed = false;

      // Float-tolerant comparison
      const tryParseFloat = (s: string) => {
        const n = Number(s);
        return isNaN(n) ? null : n;
      };
      const expectedFloat = tryParseFloat(normalizedExpected);
      const actualFloat = tryParseFloat(normalizedActual);
      if (expectedFloat !== null && actualFloat !== null) {
        passed = Math.abs(expectedFloat - actualFloat) < 1e-2;
      } else {
        passed = normalizedActual === normalizedExpected;
      }

      const status = passed ? "🔥 You did it!!" : "😢 Try again!";
      const message =
        `Input:\n${tests[0].input}\n\n` +
        `Expected Output:\n${tests[0].output}\n\n` +
        `Your Output:\n${rawActualOutput}\n\n` +
        `${status}`;
      setOutput(message);
    } catch (e: any) {
      console.error("❌ Run error", e);
      setOutput(`Error: ${e.message || e}`);
    }
  };

  // Modify handleSubmit to use the new runCode function
  const handleSubmit = async () => {
    console.log("🔘 Submit clicked");
    if (loading || !pyodide) {
      console.warn("⚠️ Pyodide loading…");
      return;
    }
    try {
      setOutput("");
      let allPassed = true;
      const lines: string[] = [];
      let anyHiddenFailed = false;

      const question = allQuestions.find((q) => q.id === questionId);
      if (!question) {
        throw new Error("Question not found");
      }

      for (const testCase of tests) {
        const { input, output: expected, hidden } = testCase;
        let passed = false;

        try {
          const actualOutput = await runCode(testCase, question);
          const normalizedExpected = expected.trim().toLowerCase();
          const normalizedActual = actualOutput.trim().toLowerCase();

          // Float-tolerant comparison
          const tryParseFloat = (s: string) => {
            const n = Number(s);
            return isNaN(n) ? null : n;
          };
          const expectedFloat = tryParseFloat(normalizedExpected);
          const actualFloat = tryParseFloat(normalizedActual);
          if (expectedFloat !== null && actualFloat !== null) {
            passed = Math.abs(expectedFloat - actualFloat) < 1e-2;
          } else {
            passed = normalizedActual === normalizedExpected;
          }

          if (!passed) {
            allPassed = false;
            if (hidden) {
              anyHiddenFailed = true;
            } else {
              lines.push(
                `Input:\n${input}\n`,
                `Expected Output:\n${expected}\n`,
                `Your Output:\n${actualOutput}\n`
              );
            }
          }
        } catch (err: unknown) {
          allPassed = false;
          if (hidden) {
            anyHiddenFailed = true;
          } else {
            lines.push(
              `Input:\n${input}\n`,
              `Error: ${err instanceof Error ? err.message : String(err)}\n`
            );
          }
        }
      }

      if (anyHiddenFailed) {
        setOutput("Some hidden test cases failed. Check for edge cases!");
        return;
      }

      if (allPassed) {
        if (user && user.uid) {
          lines.push("", "🎉 All tests passed!");
          const timestamp = Date.now();
          const userRef = doc(webDb, "users", user.uid);
          await setDoc(
            userRef,
            {
              solved: { [questionId]: true },
              lastSolved: new Date().toISOString(),
              [`solved_${questionId}`]: timestamp,
            },
            { merge: true }
          );
          // Immediately update solvedMap in state
          setSolvedMap((prev) => ({ ...prev, [questionId]: true }));
        }
      }

      setOutput(lines.join("\n"));
    } catch (e: any) {
      console.error("❌ Submit error", e);
      setOutput(`Error: ${e.message || e}`);
    }
  };

  // disable Next on the last question until every ID in this level is marked solved
  const isLastInLevel = levelIds.indexOf(questionId) === levelIds.length - 1;
  const allLevelSolved =
    levelIds.length > 0 && levelIds.every((id) => solvedMap[id]);

  return (
    <div>
      {/* Editor toolbar */}
      <div className="flex items-center justify-between p-4 bg-neutral-50 border-b border-neutral-200">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-red-500"></span>
          <span className="w-3 h-3 rounded-full bg-yellow-500"></span>
          <span className="w-3 h-3 rounded-full bg-green-500"></span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRun}
            disabled={loading}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            Run Code
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-4 py-2 bg-secondary-600 text-white rounded-lg font-medium hover:bg-secondary-700 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            Submit
          </button>
        </div>
      </div>

      {/* Editor and output container */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
        {/* Code editor */}
        <div className="h-[400px] rounded-lg overflow-hidden border border-neutral-200">
          <Editor
            height="100%"
            defaultLanguage="python"
            theme="customTheme"
            value={code}
            onChange={(value) => setCode(value ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: "on",
              roundedSelection: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </div>

        {/* Output console */}
        <div className="h-[400px] bg-neutral-900 rounded-lg p-4 font-mono text-sm text-neutral-100 overflow-auto">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
            <span className="text-neutral-400">Output</span>
          </div>
          <pre className="whitespace-pre-wrap">{output}</pre>
        </div>
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center justify-between p-4 bg-neutral-50 border-t border-neutral-200">
        <button
          onClick={() => prevId && router.push(`/q/${prevId}`)}
          disabled={!prevId}
          className="px-4 py-2 text-neutral-600 hover:text-neutral-900 disabled:opacity-50 disabled:hover:text-neutral-600 transition-colors flex items-center gap-2"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Previous
        </button>
        <button
          onClick={() => nextId && router.push(`/q/${nextId}`)}
          disabled={!nextId || (isLastInLevel && !allLevelSolved)}
          className="px-4 py-2 text-neutral-600 hover:text-neutral-900 disabled:opacity-50 disabled:hover:text-neutral-600 transition-colors flex items-center gap-2"
        >
          Next
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
