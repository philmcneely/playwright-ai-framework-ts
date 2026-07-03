import path from "path";

export const ARTIFACT_ROOT = path.resolve("test_artifacts");
export const SCREENSHOT_DIR = path.join(ARTIFACT_ROOT, "screenshots");
export const AI_HEALING_REPORT_DIR = path.join(ARTIFACT_ROOT, "ai", "ai_healing_reports");
export const VISUAL_BASELINE_DIR = path.join(ARTIFACT_ROOT, "visual", "visual_baselines");
export const VISUAL_CURRENT_DIR = path.join(ARTIFACT_ROOT, "visual", "visual_current");
export const VISUAL_DIFF_DIR = path.join(ARTIFACT_ROOT, "visual", "visual_diffs");
export const PERFORMANCE_REPORT_DIR = path.join(ARTIFACT_ROOT, "performance", "performance_reports");
export const OBSERVABILITY_DIR = path.join(ARTIFACT_ROOT, "observability");
