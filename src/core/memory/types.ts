export interface StructuredSummary {
  action: string; // 'edit'|'fix'|'review'|'explain'|'check'|'create'|'answer'
  files: string[]; // MODIFY 修改的文件列表
  locate_files: string[]; // LOCATE 找到的文件列表
  verify_passed: boolean | null; // VERIFY 结果，null=无 VERIFY step
  key_finding: string | null; // RESEARCH/REVIEW/DIAGNOSE 核心结论，≤120字符
  error_summary: string | null; // 失败时错误描述，≤80字符
}

export interface EpisodeRow {
  rowid: number;
  id: string;
  timestamp: number; // Unix 秒
  project_root: string;
  user_input: string;
  action_type: string;
  files_changed: string | null; // JSON array string
  success: number; // 0|1
  result_summary: string; // JSON StructuredSummary
  is_summarized: number;
  step_outputs: string | null; // JSON array
  description: string | null;
  keywords: string | null; // JSON array string
  tokens_used: number;
}

export interface SemanticFact {
  id: string;
  project_root: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
  last_seen: number; // Unix 秒
  source: 'inferred' | 'explicit';
}

export interface EntityNode {
  type: string;
  name: string;
  role: string;
}

// 传给 updateSemanticFacts 的内存对象（不存 DB）
export interface EpisodeRecord {
  userInput: string;
  verifyCommands?: string[];
}
