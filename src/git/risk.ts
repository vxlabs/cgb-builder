/**
 * Risk scoring for changed files.
 * Each file is scored 0–100 based on blast radius, security keywords,
 * file type, change size, and test coverage.
 */

import * as path from 'path';

// ─── Security keywords ────────────────────────────────────────────────────────

/**
 * High-signal security keywords sourced from code-review-graph constants.
 */
export const SECURITY_KEYWORDS: readonly string[] = [
  // Authentication & credentials
  'auth', 'authenticate', 'authorization', 'login', 'logout', 'session',
  'password', 'passwd', 'credentials', 'token', 'jwt', 'oauth', 'saml',
  'secret', 'api_key', 'apikey', 'private_key', 'public_key', 'certificate',

  // Cryptography
  'crypto', 'encrypt', 'decrypt', 'hash', 'hmac', 'signature', 'sign',
  'aes', 'rsa', 'sha', 'md5', 'bcrypt', 'argon', 'pbkdf',

  // Access control
  'permission', 'permissions', 'acl', 'role', 'admin', 'root', 'superuser',
  'privilege', 'capabilities', 'policy', 'rbac', 'abac',

  // Injection / execution
  'sql', 'query', 'inject', 'injection', 'eval', 'exec', 'execute',
  'subprocess', 'shell', 'command', 'spawn', 'popen',

  // Network / input
  'cors', 'csrf', 'xss', 'sanitize', 'validate', 'input', 'request',
  'response', 'header', 'cookie', 'referer', 'redirect',

  // Sensitive data paths
  'secret', 'env', '.env', 'config', 'settings',
];

// ─── File type risk maps ──────────────────────────────────────────────────────

/**
 * Extensions with elevated inherent risk (0-15 scale).
 */
const FILE_TYPE_RISK: Record<string, number> = {
  // Credentials / env
  '.env': 15,
  '.pem': 15,
  '.key': 15,
  '.pfx': 15,
  '.p12': 15,

  // Config / infrastructure
  '.yml': 10,
  '.yaml': 10,
  '.json': 8,
  '.toml': 8,
  '.ini': 8,
  '.cfg': 8,
  '.conf': 8,

  // Source: auth-adjacent names handled via keyword scoring
  '.ts': 5,
  '.js': 5,
  '.py': 5,
  '.cs': 5,
  '.java': 5,
  '.go': 5,
};

/** High-risk filename patterns (checked case-insensitively) */
const HIGH_RISK_FILENAMES: readonly RegExp[] = [
  /auth/i,
  /login/i,
  /password/i,
  /credentials?/i,
  /token/i,
  /secret/i,
  /config/i,
  /settings/i,
  /env\.?/i,
  /security/i,
  /permission/i,
  /middleware/i,
];

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface RiskFactors {
  /** 0-30: transitively affected file count */
  blastRadiusScore: number;
  /** 0-25: security keyword hits */
  securityKeywordScore: number;
  /** 0-15: based on extension and filename */
  fileTypeScore: number;
  /** 0-15: diff size */
  changeSizeScore: number;
  /** 0-15: penalise files with no test coverage */
  testCoverageScore: number;
  /** Aggregated 0-100 */
  total: number;
}

export interface FileRisk {
  filePath: string;
  score: number;
  factors: RiskFactors;
  securityRelevant: boolean;
}

/**
 * Score a single changed file.
 *
 * @param filePath     Absolute file path
 * @param blastRadius  Number of files transitively affected
 * @param linesChanged Total lines added + removed
 * @param hasTests     Whether a test file imports / references this file
 * @param fileContent  Optional file content for keyword scanning
 */
export function scoreFile(
  filePath: string,
  blastRadius: number,
  linesChanged: number,
  hasTests: boolean,
  fileContent?: string,
): FileRisk {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  // ── 1. Blast radius (0-30) ─────────────────────────────────────────────────
  // Scale: ≥50 affected → 30 pts, linear otherwise
  const blastRadiusScore = Math.min(30, Math.round((blastRadius / 50) * 30));

  // ── 2. Security keywords (0-25) ───────────────────────────────────────────
  let keywordHits = 0;
  const contentToScan = (fileContent ?? '') + ' ' + filePath.toLowerCase();
  for (const kw of SECURITY_KEYWORDS) {
    if (contentToScan.toLowerCase().includes(kw)) {
      keywordHits++;
    }
  }
  const securityKeywordScore = Math.min(25, Math.round((keywordHits / 5) * 25));

  // ── 3. File type (0-15) ────────────────────────────────────────────────────
  let fileTypeScore = FILE_TYPE_RISK[ext] ?? 2;
  // Bump further if the filename matches a high-risk pattern
  if (HIGH_RISK_FILENAMES.some((re) => re.test(basename))) {
    fileTypeScore = Math.min(15, fileTypeScore + 7);
  }

  // ── 4. Change size (0-15) ─────────────────────────────────────────────────
  // Scale: ≥500 lines changed → 15 pts
  const changeSizeScore = Math.min(15, Math.round((linesChanged / 500) * 15));

  // ── 5. Test coverage (0-15) ────────────────────────────────────────────────
  // Files with NO test coverage score maximum penalty
  const testCoverageScore = hasTests ? 0 : 15;

  const total = Math.min(
    100,
    blastRadiusScore + securityKeywordScore + fileTypeScore + changeSizeScore + testCoverageScore,
  );

  const securityRelevant = securityKeywordScore >= 10 || HIGH_RISK_FILENAMES.some((re) => re.test(basename));

  return {
    filePath,
    score: total,
    factors: {
      blastRadiusScore,
      securityKeywordScore,
      fileTypeScore,
      changeSizeScore,
      testCoverageScore,
      total,
    },
    securityRelevant,
  };
}

/**
 * Convert a numeric score into a risk band.
 */
export function riskBand(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/**
 * Aggregate a set of per-file scores into an overall risk band.
 * Uses the maximum score to avoid masking high-risk outliers.
 */
export function overallRisk(scores: number[]): 'low' | 'medium' | 'high' | 'critical' {
  if (scores.length === 0) return 'low';
  return riskBand(Math.max(...scores));
}

/**
 * Check whether a file path looks like a test file.
 */
export function isTestFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    norm.includes('/__tests__/') ||
    norm.includes('/test/') ||
    norm.includes('/tests/') ||
    norm.includes('/spec/') ||
    norm.endsWith('.test.ts') ||
    norm.endsWith('.test.js') ||
    norm.endsWith('.spec.ts') ||
    norm.endsWith('.spec.js') ||
    norm.endsWith('_test.go') ||
    norm.endsWith('_test.py') ||
    norm.endsWith('test.cs')
  );
}
