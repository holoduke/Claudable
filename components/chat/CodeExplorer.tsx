"use client";
import type { ChangeEvent, KeyboardEvent, RefObject, UIEvent } from 'react';
import { MotionDiv } from '@/lib/motion';
import { FaCode, FaCog, FaFolder, FaFolderOpen, FaFile, FaFileCode, FaCss3Alt, FaHtml5, FaJs, FaReact, FaPython, FaDocker, FaMarkdown, FaDatabase, FaPhp, FaJava, FaRust, FaVuejs, FaLock, FaChevronRight, FaChevronDown } from 'react-icons/fa';
import { SiTypescript, SiGo, SiRuby, SiSvelte, SiYaml, SiCplusplus } from 'react-icons/si';
import { VscJson } from 'react-icons/vsc';
import { getFileLanguage } from '@/lib/utils/format';

export type Entry = { path: string; type: 'file'|'dir'; size?: number };

// TreeView component for VSCode-style file explorer
interface TreeViewProps {
  entries: Entry[];
  selectedFile: string;
  expandedFolders: Set<string>;
  folderContents: Map<string, Entry[]>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onLoadFolder: (path: string) => Promise<void>;
  level: number;
  parentPath?: string;
  getFileIcon: (entry: Entry) => React.ReactElement;
}

function TreeView({ entries, selectedFile, expandedFolders, folderContents, onToggleFolder, onSelectFile, onLoadFolder, level, parentPath = '', getFileIcon }: TreeViewProps) {
  // Ensure entries is an array
  if (!entries || !Array.isArray(entries)) {
    return null;
  }

  // Group entries by directory
  const sortedEntries = [...entries].sort((a, b) => {
    // Directories first
    if (a.type === 'dir' && b.type === 'file') return -1;
    if (a.type === 'file' && b.type === 'dir') return 1;
    // Then alphabetical
    return a.path.localeCompare(b.path);
  });

  return (
    <>
      {sortedEntries.map((entry, index) => {
        // entry.path should already be the full path from API
        const fullPath = entry.path;
        let entryKey =
          fullPath && typeof fullPath === 'string' && fullPath.trim().length > 0
            ? fullPath.trim()
            : (entry as any)?.name && typeof (entry as any).name === 'string' && (entry as any).name.trim().length > 0
            ? `${parentPath || 'root'}::__named_${(entry as any).name.trim()}`
            : '';
        if (!entryKey || entryKey.trim().length === 0) {
          entryKey = `${parentPath || 'root'}::__entry_${level}_${index}_${entry.type}`;
        }
        const isExpanded = expandedFolders.has(fullPath);
        const indent = level * 8;

        return (
          <div key={entryKey}>
            <div
              className={`group flex items-center h-[22px] px-2 cursor-pointer ${
                selectedFile === fullPath
                  ? 'bg-blue-100 dark:bg-blue-950/40 '
                  : 'hover:bg-gray-100 dark:hover:bg-white/6 '
              }`}
              style={{ paddingLeft: `${8 + indent}px` }}
              onClick={async () => {
                if (entry.type === 'dir') {
                  // Load folder contents if not already loaded
                  if (!folderContents.has(fullPath)) {
                    await onLoadFolder(fullPath);
                  }
                  onToggleFolder(fullPath);
                } else {
                  onSelectFile(fullPath);
                }
              }}
            >
              {/* Chevron for folders */}
              <div className="w-4 flex items-center justify-center mr-0.5">
                {entry.type === 'dir' && (
                  isExpanded ?
                    <span className="w-2.5 h-2.5 text-gray-600 dark:text-gray-300 flex items-center justify-center"><FaChevronDown size={10} /></span> :
                    <span className="w-2.5 h-2.5 text-gray-600 dark:text-gray-300 flex items-center justify-center"><FaChevronRight size={10} /></span>
                )}
              </div>

              {/* Icon */}
              <span className="w-4 h-4 flex items-center justify-center mr-1.5">
                {entry.type === 'dir' ? (
                  isExpanded ?
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><FaFolderOpen size={16} /></span> :
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><FaFolder size={16} /></span>
                ) : (
                  getFileIcon(entry)
                )}
              </span>

              {/* File/Folder name */}
              <span className={`text-[13px] leading-[22px] ${
                selectedFile === fullPath ? 'text-blue-700 dark:text-blue-300 ' : 'text-gray-700 dark:text-gray-200 '
              }`} style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
                {level === 0 ? (entry.path.split('/').pop() || entry.path) : (entry.path.split('/').pop() || entry.path)}
              </span>
            </div>

            {/* Render children if expanded */}
            {entry.type === 'dir' && isExpanded && folderContents.has(fullPath) && (
              <TreeView
                entries={folderContents.get(fullPath) || []}
                selectedFile={selectedFile}
                expandedFolders={expandedFolders}
                folderContents={folderContents}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                onLoadFolder={onLoadFolder}
                level={level + 1}
                parentPath={fullPath}
                getFileIcon={getFileIcon}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

// Get file icon based on type
function getFileIcon(entry: Entry): React.ReactElement {
  if (entry.type === 'dir') {
    return <span className="text-blue-500"><FaFolder size={16} /></span>;
  }

  const ext = entry.path.split('.').pop()?.toLowerCase();
  const filename = entry.path.split('/').pop()?.toLowerCase();

  // Special files
  if (filename === 'package.json') return <span className="text-green-600"><VscJson size={16} /></span>;
  if (filename === 'dockerfile') return <span className="text-blue-400"><FaDocker size={16} /></span>;
  if (filename?.startsWith('.env')) return <span className="text-yellow-500"><FaLock size={16} /></span>;
  if (filename === 'readme.md') return <span className="text-gray-600 dark:text-gray-300"><FaMarkdown size={16} /></span>;
  if (filename?.includes('config')) return <span className="text-gray-500 dark:text-gray-400"><FaCog size={16} /></span>;

  switch (ext) {
    case 'tsx':
      return <span className="text-cyan-400"><FaReact size={16} /></span>;
    case 'ts':
      return <span className="text-blue-600"><SiTypescript size={16} /></span>;
    case 'jsx':
      return <span className="text-cyan-400"><FaReact size={16} /></span>;
    case 'js':
    case 'mjs':
      return <span className="text-yellow-400"><FaJs size={16} /></span>;
    case 'css':
      return <span className="text-blue-500"><FaCss3Alt size={16} /></span>;
    case 'scss':
    case 'sass':
      return <span className="text-pink-500"><FaCss3Alt size={16} /></span>;
    case 'html':
    case 'htm':
      return <span className="text-orange-500"><FaHtml5 size={16} /></span>;
    case 'json':
      return <span className="text-yellow-600"><VscJson size={16} /></span>;
    case 'md':
    case 'markdown':
      return <span className="text-gray-600 dark:text-gray-300"><FaMarkdown size={16} /></span>;
    case 'py':
      return <span className="text-blue-400"><FaPython size={16} /></span>;
    case 'sh':
    case 'bash':
      return <span className="text-green-500"><FaFileCode size={16} /></span>;
    case 'yaml':
    case 'yml':
      return <span className="text-red-500"><SiYaml size={16} /></span>;
    case 'xml':
      return <span className="text-orange-600"><FaFileCode size={16} /></span>;
    case 'sql':
      return <span className="text-blue-600"><FaDatabase size={16} /></span>;
    case 'php':
      return <span className="text-indigo-500"><FaPhp size={16} /></span>;
    case 'java':
      return <span className="text-red-600"><FaJava size={16} /></span>;
    case 'c':
      return <span className="text-blue-700"><FaFileCode size={16} /></span>;
    case 'cpp':
    case 'cc':
    case 'cxx':
      return <span className="text-blue-600"><SiCplusplus size={16} /></span>;
    case 'rs':
      return <span className="text-orange-700"><FaRust size={16} /></span>;
    case 'go':
      return <span className="text-cyan-500"><SiGo size={16} /></span>;
    case 'rb':
      return <span className="text-red-500"><SiRuby size={16} /></span>;
    case 'vue':
      return <span className="text-green-500"><FaVuejs size={16} /></span>;
    case 'svelte':
      return <span className="text-orange-600"><SiSvelte size={16} /></span>;
    case 'dockerfile':
      return <span className="text-blue-400"><FaDocker size={16} /></span>;
    case 'toml':
    case 'ini':
    case 'conf':
    case 'config':
      return <span className="text-gray-500 dark:text-gray-400"><FaCog size={16} /></span>;
    default:
      return <span className="text-gray-400 dark:text-gray-500"><FaFile size={16} /></span>;
  }
}

interface CodeExplorerProps {
  tree: Entry[];
  selectedFile: string;
  expandedFolders: Set<string>;
  folderContents: Map<string, Entry[]>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onLoadFolder: (path: string) => Promise<void>;
  hasUnsavedChanges: boolean;
  isSavingFile: boolean;
  saveFeedback: 'idle' | 'success' | 'error';
  saveError: string | null;
  isFileUpdating: boolean;
  editedContent: string;
  highlightedCode: string;
  onSaveFile: () => void;
  onCloseFile: () => void;
  onEditorChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onEditorScroll: (event: UIEvent<HTMLTextAreaElement>) => void;
  onEditorKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  highlightRef: RefObject<HTMLPreElement | null>;
  lineNumberRef: RefObject<HTMLDivElement | null>;
}

export default function CodeExplorer({
  tree,
  selectedFile,
  expandedFolders,
  folderContents,
  onToggleFolder,
  onSelectFile,
  onLoadFolder,
  hasUnsavedChanges,
  isSavingFile,
  saveFeedback,
  saveError,
  isFileUpdating,
  editedContent,
  highlightedCode,
  onSaveFile,
  onCloseFile,
  onEditorChange,
  onEditorScroll,
  onEditorKeyDown,
  editorRef,
  highlightRef,
  lineNumberRef,
}: CodeExplorerProps) {
  return (
    <MotionDiv
      key="code"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="h-full flex bg-white dark:bg-[#0c0a09] "
    >
      {/* Left Sidebar - File Explorer (VS Code style) */}
      <div className="w-64 shrink-0 bg-gray-50 dark:bg-white/3 border-r border-gray-200 dark:border-white/8 flex flex-col">
        {/* File Tree */}
        <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-white/3 custom-scrollbar">
          {!tree || tree.length === 0 ? (
            <div className="px-3 py-8 text-center text-[11px] text-gray-600 dark:text-gray-300 select-none">
              No files found
            </div>
          ) : (
            <TreeView
              entries={tree || []}
              selectedFile={selectedFile}
              expandedFolders={expandedFolders}
              folderContents={folderContents}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              onLoadFolder={onLoadFolder}
              level={0}
              parentPath=""
              getFileIcon={getFileIcon}
            />
          )}
        </div>
      </div>

      {/* Right Editor Area */}
      <div className="flex-1 flex flex-col bg-white dark:bg-[#0c0a09] min-w-0">
        {selectedFile ? (
          <>
            {/* File Tab */}
            <div className="shrink-0 bg-gray-100 dark:bg-white/3 ">
              <div className="flex items-center gap-3 bg-white dark:bg-[#0c0a09] px-3 py-1.5 border-t-2 border-t-[#DE7356] ">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-4 h-4 flex items-center justify-center">
                    {getFileIcon(tree.find(e => e.path === selectedFile) || { path: selectedFile, type: 'file' })}
                  </span>
                  <span className="truncate text-[13px] text-gray-700 dark:text-gray-200 " style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
                    {selectedFile.split('/').pop()}
                  </span>
                </div>
                {hasUnsavedChanges && (
                  <span className="text-[11px] text-amber-600 ">
                    • Unsaved changes
                  </span>
                )}
                {!hasUnsavedChanges && saveFeedback === 'success' && (
                  <span className="text-[11px] text-green-600 ">
                    Saved
                  </span>
                )}
                {saveFeedback === 'error' && (
                  <span
                    className="text-[11px] text-red-600 truncate max-w-[160px]"
                    title={saveError ?? 'Failed to save file'}
                  >
                    Save error
                  </span>
                )}
                {!hasUnsavedChanges && saveFeedback !== 'success' && isFileUpdating && (
                  <span className="text-[11px] text-green-600 ">
                    Updated
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    className="px-3 py-1 text-xs font-medium rounded-sm bg-[#DE7356] text-white hover:bg-[#c9634a] disabled:bg-gray-300 disabled:text-gray-600 disabled:cursor-not-allowed "
                    onClick={onSaveFile}
                    disabled={!hasUnsavedChanges || isSavingFile}
                    title="Save (Ctrl+S)"
                  >
                    {isSavingFile ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    className="text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/6 px-1 rounded-sm"
                    onClick={onCloseFile}
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>

            {/* Code Editor */}
            <div className="flex-1 overflow-hidden">
              <div className="w-full h-full flex bg-white dark:bg-[#0c0a09] overflow-hidden">
                {/* Line Numbers */}
                <div
                  ref={lineNumberRef}
                  className="bg-gray-50 dark:bg-[#0c0a09] px-3 py-4 select-none shrink-0 overflow-y-auto overflow-x-hidden custom-scrollbar pointer-events-none"
                  aria-hidden="true"
                >
                  <div className="text-[13px] font-mono text-gray-500 dark:text-gray-400 leading-[19px]">
                    {(editedContent || '').split('\n').map((_, index) => (
                      <div key={index} className="text-right pr-2">
                        {index + 1}
                      </div>
                    ))}
                  </div>
                </div>
                {/* Code Content */}
                <div className="relative flex-1">
                  <pre
                    ref={highlightRef}
                    aria-hidden="true"
                    className="absolute inset-0 m-0 p-4 overflow-hidden text-[13px] leading-[19px] font-mono text-gray-800 dark:text-gray-100 whitespace-pre pointer-events-none"
                    style={{ fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace" }}
                  >
                    <code
                      className={`language-${getFileLanguage(selectedFile)}`}
                      dangerouslySetInnerHTML={{ __html: highlightedCode }}
                    />
                    <span className="block h-full min-h-px" />
                  </pre>
                  <textarea
                    ref={editorRef}
                    value={editedContent}
                    onChange={onEditorChange}
                    onScroll={onEditorScroll}
                    onKeyDown={onEditorKeyDown}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="none"
                    autoComplete="off"
                    wrap="off"
                    aria-label="Code editor"
                    className="absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-gray-800 outline-hidden font-mono text-[13px] leading-[19px] p-4 whitespace-pre overflow-auto custom-scrollbar"
                    style={{ fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace" }}
                  />
                </div>
              </div>
            </div>
          </>
        ) : (
          /* Welcome Screen */
          <div className="flex-1 flex items-center justify-center bg-white dark:bg-[#0c0a09] ">
            <div className="text-center">
              <span className="w-16 h-16 mb-4 opacity-10 text-gray-400 dark:text-gray-500 mx-auto flex items-center justify-center"><FaCode size={64} /></span>
              <h3 className="text-lg font-medium text-gray-700 dark:text-gray-200 mb-2">
                Welcome to Code Editor
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 ">
                Select a file from the explorer to start viewing code
              </p>
            </div>
          </div>
        )}
      </div>
    </MotionDiv>
  );
}
