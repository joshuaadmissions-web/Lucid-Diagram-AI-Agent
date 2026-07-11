#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// Types
// ============================================================

interface RepoInfo {
  name: string;
  full_name: string;
  description: string;
  language: string;
  topics: string[];
  default_branch: string;
  stars: number;
  forks: number;
  size: number;
  created_at: string;
  updated_at: string;
}

interface RepoContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
}

interface Dependency {
  name: string;
  version: string;
  type: 'production' | 'development';
}

interface FileAnalysis {
  path: string;
  language: string;
  imports: string[];
  exports: string[];
  classes: string[];
  functions: string[];
  size: number;
}

interface RepoAnalysis {
  repo: RepoInfo;
  languages: Record<string, number>;
  dependencies: Dependency[];
  structure: RepoContent[];
  keyFiles: FileAnalysis[];
  entryPoints: string[];
  architecture: {
    type: string;
    framework: string;
    description: string;
    patterns: string[];
  };
  stats: {
    totalFiles: number;
    totalLines: number;
    avgFileSize: number;
  };
}

interface LucidShape {
  id: string;
  type: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
  strokeColor?: string;
  fontSize?: number;
}

interface LucidLine {
  id: string;
  startShapeId: string;
  endShapeId: string;
  text?: string;
  lineStyle?: string;
}

interface LucidDocument {
  title: string;
  shapes: LucidShape[];
  lines: LucidLine[];
  metadata?: {
    generatedAt: string;
    repoUrl: string;
    diagramType: string;
  };
}

// ============================================================
// Configuration
// ============================================================

const GITHUB_API_BASE = 'https://api.github.com';
const LUCID_API_BASE = 'https://api.lucid.co';

const LUCID_API_KEY = process.env.LUCID_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const MAX_FILES_TO_ANALYZE = 50;
const MAX_DEPENDENCIES_TO_SHOW = 15;

// ============================================================
// GitHub Analyzer
// ============================================================

class GitHubAnalyzer {
  private axiosInstance;
  private cache: Map<string, any> = new Map();

  constructor() {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'lucid-diagram-agent/2.0',
    };
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    }
    this.axiosInstance = axios.create({
      baseURL: GITHUB_API_BASE,
      headers,
      timeout: 30000,
    });
  }

  private parseRepoUrl(url: string): { owner: string; repo: string } {
    // Handle formats: https://github.com/owner/repo, owner/repo, git@github.com:owner/repo.git
    const match = url.match(
      /(?:https?:\/\/github\.com\/|git@github\.com:)([^\/]+)\/([^\/\.]+)(?:\.git)?\/?$/
    ) || url.match(/^([^\/]+)\/([^\/]+)$/);
    
    if (!match) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid GitHub URL: ${url}. Expected format: owner/repo or https://github.com/owner/repo`
      );
    }
    return { owner: match[1], repo: match[2] };
  }

  private getCacheKey(endpoint: string): string {
    return endpoint;
  }

  private async getWithCache<T>(endpoint: string): Promise<T> {
    const cacheKey = this.getCacheKey(endpoint);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const { data } = await this.axiosInstance.get(endpoint);
    this.cache.set(cacheKey, data);
    return data;
  }

  async getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
    const data = await this.getWithCache<any>(`/repos/${owner}/${repo}`);
    return {
      name: data.name,
      full_name: data.full_name,
      description: data.description || '',
      language: data.language || 'Unknown',
      topics: data.topics || [],
      default_branch: data.default_branch,
      stars: data.stargazers_count,
      forks: data.forks_count,
      size: data.size,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  async getLanguages(owner: string, repo: string): Promise<Record<string, number>> {
    const data = await this.getWithCache<any>(`/repos/${owner}/${repo}/languages`);
    return data;
  }

  async getRepoContents(owner: string, repo: string, path: string = ''): Promise<RepoContent[]> {
    try {
      const { data } = await this.axiosInstance.get(`/repos/${owner}/${repo}/contents/${path}`);
      if (Array.isArray(data)) {
        return data.map((item: any) => ({
          name: item.name,
          path: item.path,
          type: item.type as 'file' | 'dir',
          size: item.size,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  async getFileContent(owner: string, repo: string, path: string): Promise<string> {
    try {
      const { data } = await this.axiosInstance.get(`/repos/${owner}/${repo}/contents/${path}`);
      if (data.content) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      return '';
    } catch {
      return '';
    }
  }

  async getDependencies(owner: string, repo: string): Promise<Dependency[]> {
    const deps: Dependency[] = [];
    
    // Check common dependency files
    const depFiles = [
      'package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
      'Gemfile', 'pom.xml', 'build.gradle', 'CMakeLists.txt',
      'composer.json', 'Pipfile', 'pyproject.toml'
    ];

    for (const file of depFiles) {
      const content = await this.getFileContent(owner, repo, file);
      if (content) {
        deps.push(...this.parseDependencies(content, file));
      }
    }

    return deps;
  }

  private parseDependencies(content: string, filename: string): Dependency[] {
    const deps: Dependency[] = [];

    try {
      if (filename === 'package.json') {
        const json = JSON.parse(content);
        const prod = json.dependencies || {};
        const dev = json.devDependencies || {};
        for (const [name, version] of Object.entries(prod)) {
          deps.push({ name, version: String(version), type: 'production' });
        }
        for (const [name, version] of Object.entries(dev)) {
          deps.push({ name, version: String(version), type: 'development' });
        }
      } else if (filename === 'requirements.txt' || filename === 'Pipfile') {
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('[')) {
            const parts = trimmed.split(/[=<>~!]/);
            deps.push({ name: parts[0].trim(), version: parts[1]?.trim() || '*', type: 'production' });
          }
        }
      } else if (filename === 'Cargo.toml') {
        const lines = content.split('\n');
        let inDeps = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[dependencies]')) inDeps = true;
          else if (trimmed.startsWith('[') && !trimmed.startsWith('[dependencies.')) inDeps = false;
          else if (inDeps && trimmed && !trimmed.startsWith('#')) {
            const parts = trimmed.split('=');
            deps.push({ name: parts[0].trim(), version: parts[1]?.trim().replace(/["\s]/g, '') || '*', type: 'production' });
          }
        }
      } else if (filename === 'go.mod') {
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('module')) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
              deps.push({ name: parts[0], version: parts[1], type: 'production' });
            }
          }
        }
      }
    } catch {
      // Skip unparseable files
    }

    return deps;
  }

  async analyzeFile(owner: string, repo: string, path: string): Promise<FileAnalysis | null> {
    const content = await this.getFileContent(owner, repo, path);
    if (!content) return null;

    const ext = path.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
      'js': 'JavaScript', 'jsx': 'JavaScript', 'ts': 'TypeScript', 'tsx': 'TypeScript',
      'py': 'Python', 'java': 'Java', 'rb': 'Ruby', 'go': 'Go', 'rs': 'Rust',
      'php': 'PHP', 'swift': 'Swift', 'kt': 'Kotlin', 'scala': 'Scala',
      'c': 'C', 'cpp': 'C++', 'h': 'C/C++ Header', 'cs': 'C#',
    };
    const language = languageMap[ext] || ext;

    const imports: string[] = [];
    const exports: string[] = [];
    const classes: string[] = [];
    const functions: string[] = [];

    // Extract imports
    const importRegexes = [
      /import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/g,
      /from\s+['"]([^'"]+)['"]/g,
      /require\(['"]([^'"]+)['"]\)/g,
      /import\s+([^\s;]+)/g,
      /use\s+crate\s+::\s*([^;]+)/g,
      /#include\s+[<"]([^>"]+)[>"]/g,
    ];
    for (const regex of importRegexes) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        imports.push(match[1]);
      }
    }

    // Extract exports
    const exportRegexes = [
      /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g,
      /module\.exports\s*=\s*(\w+)/g,
      /def\s+(\w+)/g,
      /pub\s+(?:fn|struct|enum|trait)\s+(\w+)/g,
    ];
    for (const regex of exportRegexes) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        exports.push(match[1]);
      }
    }

    // Extract classes
    const classRegexes = [
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g,
      /class\s+(\w+)/g,
      /pub\s+struct\s+(\w+)/g,
      /pub\s+enum\s+(\w+)/g,
    ];
    for (const regex of classRegexes) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        classes.push(match[1]);
      }
    }

    // Extract functions
    const funcRegexes = [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      /def\s+(\w+)/g,
      /func\s+(\w+)/g,
      /fn\s+(\w+)/g,
      /pub\s+fn\s+(\w+)/g,
    ];
    for (const regex of funcRegexes) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        functions.push(match[1]);
      }
    }

    return {
      path,
      language,
      imports: [...new Set(imports)],
      exports: [...new Set(exports)],
      classes: [...new Set(classes)],
      functions: [...new Set(functions)],
      size: content.length,
    };
  }

  async analyzeRepo(url: string): Promise<RepoAnalysis> {
    const { owner, repo } = this.parseRepoUrl(url);
    
    // Get basic info
    const repoInfo = await this.getRepoInfo(owner, repo);
    const languages = await this.getLanguages(owner, repo);
    const dependencies = await this.getDependencies(owner, repo);
    
    // Get top-level structure
    const structure = await this.getRepoContents(owner, repo);
    
    // Analyze key files
    const keyPaths = ['src', 'lib', 'app', 'server', 'client', 'backend', 'frontend', 'pkg', 'cmd'];
    const keyFiles: FileAnalysis[] = [];
    const entryPoints: string[] = [];
    let totalLines = 0;

    // Check common entry points
    const entryCandidates = [
      'index.js', 'index.ts', 'app.js', 'app.ts', 'main.js', 'main.ts',
      'server.js', 'server.ts', 'index.py', 'main.py', 'app.py',
      'main.go', 'main.rs', 'lib.rs', 'index.html', 'main.cpp', 'main.c',
    ];

    for (const file of structure) {
      if (file.type === 'file' && entryCandidates.includes(file.name)) {
        entryPoints.push(file.path);
        const analysis = await this.analyzeFile(owner, repo, file.path);
        if (analysis) {
          keyFiles.push(analysis);
          totalLines += analysis.size;
        }
      }
    }

    // Analyze key directories
    let filesAnalyzed = 0;
    for (const dir of keyPaths) {
      if (filesAnalyzed >= MAX_FILES_TO_ANALYZE) break;
      const dirContent = await this.getRepoContents(owner, repo, dir);
      for (const item of dirContent.slice(0, 15)) {
        if (filesAnalyzed >= MAX_FILES_TO_ANALYZE) break;
        if (item.type === 'file') {
          const analysis = await this.analyzeFile(owner, repo, item.path);
          if (analysis) {
            keyFiles.push(analysis);
            totalLines += analysis.size;
            filesAnalyzed++;
          }
        }
      }
    }

    // Determine architecture type and patterns
    const allDeps = dependencies.map(d => d.name.toLowerCase());
    const allImports = keyFiles.flatMap(f => f.imports.map(i => i.toLowerCase()));
    const allContext = [...allDeps, ...allImports];

    let archType = 'Monolithic';
    let framework = 'Unknown';
    const patterns: string[] = [];

    // Detect architecture patterns
    if (allContext.some(d => d.includes('react') || d.includes('vue') || d.includes('angular'))) {
      if (allContext.some(d => d.includes('next'))) {
        archType = 'Full-Stack Framework';
        framework = 'Next.js';
        patterns.push('SSR/SSG', 'React');
      } else if (allContext.some(d => d.includes('express') || d.includes('fastify'))) {
        archType = 'Full-Stack (Frontend + API)';
        framework = allContext.find(d => d.includes('react')) ? 'React + Express' : 'Frontend Framework + API';
        patterns.push('REST API', 'SPA');
      } else {
        archType = 'SPA (Single Page Application)';
        framework = allContext.find(d => d.includes('react')) ? 'React' :
                    allContext.find(d => d.includes('vue')) ? 'Vue.js' : 'Angular';
        patterns.push('Client-side rendering');
      }
    } else if (allContext.some(d => d.includes('express') || d.includes('koa') || d.includes('fastify'))) {
      archType = 'API Server';
      framework = allContext.find(d => d.includes('express')) ? 'Express.js' :
                  allContext.find(d => d.includes('fastify')) ? 'Fastify' : 'Koa.js';
      patterns.push('REST API', 'Middleware');
    } else if (allContext.some(d => d.includes('django') || d.includes('flask') || d.includes('fastapi'))) {
      archType = 'Web Framework';
      framework = allContext.find(d => d.includes('django')) ? 'Django' :
                  allContext.find(d => d.includes('fastapi')) ? 'FastAPI' : 'Flask';
      patterns.push('MVC', 'ORM');
    } else if (allContext.some(d => d.includes('spring') || d.includes('jakarta'))) {
      archType = 'Enterprise Application';
      framework = 'Spring Boot';
      patterns.push('Dependency Injection', 'MVC');
    } else if (allContext.some(d => d.includes('tensorflow') || d.includes('pytorch') || d.includes('keras'))) {
      archType = 'Machine Learning';
      framework = allContext.find(d => d.includes('tensorflow')) ? 'TensorFlow' : 'PyTorch';
      patterns.push('Neural Networks', 'Data Pipeline');
    } else if (allContext.some(d => d.includes('docker') || d.includes('kubernetes'))) {
      patterns.push('Containerization', 'Microservices');
    }

    // Detect additional patterns
    if (allContext.some(d => d.includes('graphql'))) patterns.push('GraphQL');
    if (allContext.some(d => d.includes('mongodb') || d.includes('mongoose'))) patterns.push('NoSQL');
    if (allContext.some(d => d.includes('postgres') || d.includes('mysql'))) patterns.push('SQL Database');
    if (allContext.some(d => d.includes('redis'))) patterns.push('Caching');
    if (allContext.some(d => d.includes('websocket') || d.includes('socket.io'))) patterns.push('WebSockets');
    if (allContext.some(d => d.includes('grpc') || d.includes('protobuf'))) patterns.push('gRPC');

    const langSummary = Object.entries(languages)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([lang, bytes]) => `${lang} (${(bytes / Object.values(languages).reduce((a, b) => a + b, 0) * 100).toFixed(1)}%)`)
      .join(', ');

    let archDescription = `${repoInfo.name} is a ${archType.toLowerCase()} project built primarily with ${langSummary}. `;
    if (dependencies.length > 0) {
      archDescription += `It has ${dependencies.filter(d => d.type === 'production').length} production dependencies and ${dependencies.filter(d => d.type === 'development').length} dev dependencies. `;
    }
    if (entryPoints.length > 0) {
      archDescription += `Entry points: ${entryPoints.join(', ')}.`;
    }

    return {
      repo: repoInfo,
      languages,
      dependencies,
      structure,
      keyFiles,
      entryPoints,
      architecture: {
        type: archType,
        framework,
        description: archDescription,
        patterns,
      },
      stats: {
        totalFiles: structure.length,
        totalLines,
        avgFileSize: totalLines / Math.max(keyFiles.length, 1),
      },
    };
  }
}

// ============================================================
// Lucid Charts Diagram Generator
// ============================================================

class LucidDiagramGenerator {
  private axiosInstance;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: LUCID_API_BASE,
      headers: {
        'Authorization': `Bearer ${LUCID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  generateArchitectureDiagram(analysis: RepoAnalysis): LucidDocument {
    const shapes: LucidShape[] = [];
    const lines: LucidLine[] = [];
    let shapeId = 0;
    const shapeMap = new Map<string, string>();

    const nextId = () => `shape_${shapeId++}`;
    const COLORS = {
      repo: '#4A90D9',
      lang: '#50C878',
      deps: '#FF6B6B',
      arch: '#FFD700',
      entry: '#9B59B6',
      module: '#00CED1',
      pattern: '#FFA500',
    };

    // Title / Repo box
    const repoId = nextId();
    shapeMap.set('repo', repoId);
    shapes.push({
      id: repoId,
      type: 'Rectangle',
      text: `📦 ${analysis.repo.name}\n${analysis.repo.description?.substring(0, 80) || 'No description'}`,
      x: 350,
      y: 20,
      width: 400,
      height: 80,
      fillColor: COLORS.repo,
      strokeColor: '#2C5F8A',
      fontSize: 14,
    });

    // Architecture type box
    const archId = nextId();
    shapeMap.set('arch', archId);
    shapes.push({
      id: archId,
      type: 'Rectangle',
      text: `🏗️ ${analysis.architecture.type}\nFramework: ${analysis.architecture.framework}`,
      x: 350,
      y: 120,
      width: 400,
      height: 70,
      fillColor: COLORS.arch,
      strokeColor: '#B8960F',
      fontSize: 13,
    });

    lines.push({
      id: `line_${shapeId++}`,
      startShapeId: repoId,
      endShapeId: archId,
      text: 'architecture',
    });

    // Languages section
    const langEntries = Object.entries(analysis.languages)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    const langTitleId = nextId();
    shapes.push({
      id: langTitleId,
      type: 'Rectangle',
      text: '🔤 Languages',
      x: 20,
      y: 220,
      width: 200,
      height: 40,
      fillColor: COLORS.lang,
      strokeColor: '#2E8B57',
      fontSize: 12,
    });

    lines.push({
      id: `line_${shapeId++}`,
      startShapeId: archId,
      endShapeId: langTitleId,
    });

    langEntries.forEach(([lang, bytes], i) => {
      const langId = nextId();
      const totalBytes = Object.values(analysis.languages).reduce((a, b) => a + b, 0);
      const pct = ((bytes / totalBytes) * 100).toFixed(1);
      shapes.push({
        id: langId,
        type: 'Rectangle',
        text: `${lang}: ${pct}%`,
        x: 20,
        y: 270 + i * 45,
        width: 200,
        height: 35,
        fillColor: COLORS.lang,
        strokeColor: '#2E8B57',
        fontSize: 11,
      });
      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: langTitleId,
        endShapeId: langId,
      });
    });

    // Dependencies section
    const prodDeps = analysis.dependencies.filter(d => d.type === 'production').slice(0, MAX_DEPENDENCIES_TO_SHOW);
    const devDeps = analysis.dependencies.filter(d => d.type === 'development').slice(0, 5);

    if (prodDeps.length > 0) {
      const depsTitleId = nextId();
      shapes.push({
        id: depsTitleId,
        type: 'Rectangle',
        text: `📦 Dependencies (${analysis.dependencies.length} total)`,
        x: 600,
        y: 220,
        width: 300,
        height: 40,
        fillColor: COLORS.deps,
        strokeColor: '#CC4444',
        fontSize: 12,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: archId,
        endShapeId: depsTitleId,
      });

      [...prodDeps, ...devDeps].forEach((dep, i) => {
        const depId = nextId();
        shapes.push({
          id: depId,
          type: 'Rectangle',
          text: `${dep.name}@${dep.version}`,
          x: 600,
          y: 270 + i * 35,
          width: 300,
          height: 30,
          fillColor: dep.type === 'production' ? COLORS.deps : '#FFA07A',
          strokeColor: '#CC4444',
          fontSize: 10,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: depsTitleId,
          endShapeId: depId,
        });
      });
    }

    // Entry points
    if (analysis.entryPoints.length > 0) {
      const entryTitleId = nextId();
      shapes.push({
        id: entryTitleId,
        type: 'Rectangle',
        text: '🚪 Entry Points',
        x: 20,
        y: 500,
        width: 200,
        height: 40,
        fillColor: COLORS.entry,
        strokeColor: '#7B1FA2',
        fontSize: 12,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: repoId,
        endShapeId: entryTitleId,
      });

      analysis.entryPoints.forEach((ep, i) => {
        const epId = nextId();
        shapes.push({
          id: epId,
          type: 'Rectangle',
          text: ep,
          x: 20,
          y: 550 + i * 35,
          width: 200,
          height: 30,
          fillColor: COLORS.entry,
          strokeColor: '#7B1FA2',
          fontSize: 10,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: entryTitleId,
          endShapeId: epId,
        });
      });
    }

    // Key modules/components
    const modules = analysis.keyFiles.filter(f => f.classes.length > 0 || f.functions.length > 0).slice(0, 6);
    if (modules.length > 0) {
      const moduleTitleId = nextId();
      shapes.push({
        id: moduleTitleId,
        type: 'Rectangle',
        text: '🧩 Key Modules',
        x: 600,
        y: 500,
        width: 300,
        height: 40,
        fillColor: COLORS.module,
        strokeColor: '#008B8B',
        fontSize: 12,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: repoId,
        endShapeId: moduleTitleId,
      });

      modules.forEach((mod, i) => {
        const modId = nextId();
        const items = [...mod.classes, ...mod.functions.slice(0, 3)].join(', ');
        shapes.push({
          id: modId,
          type: 'Rectangle',
          text: `${mod.path.split('/').pop()}\n${items.substring(0, 50)}`,
          x: 600,
          y: 550 + i * 55,
          width: 300,
          height: 50,
          fillColor: COLORS.module,
          strokeColor: '#008B8B',
          fontSize: 10,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: moduleTitleId,
          endShapeId: modId,
        });
      });
    }

    // Architecture patterns
    if (analysis.architecture.patterns.length > 0) {
      const patternTitleId = nextId();
      shapes.push({
        id: patternTitleId,
        type: 'Rectangle',
        text: '🎯 Design Patterns',
        x: 350,
        y: 220,
        width: 200,
        height: 40,
        fillColor: COLORS.pattern,
        strokeColor: '#CC8400',
        fontSize: 12,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: archId,
        endShapeId: patternTitleId,
      });

      analysis.architecture.patterns.slice(0, 5).forEach((pattern, i) => {
        const patternId = nextId();
        shapes.push({
          id: patternId,
          type: 'Rectangle',
          text: pattern,
          x: 350,
          y: 270 + i * 40,
          width: 200,
          height: 35,
          fillColor: COLORS.pattern,
          strokeColor: '#CC8400',
          fontSize: 11,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: patternTitleId,
          endShapeId: patternId,
        });
      });
    }

    return {
      title: `${analysis.repo.name} - Architecture Diagram`,
      shapes,
      lines,
      metadata: {
        generatedAt: new Date().toISOString(),
        repoUrl: analysis.repo.full_name,
        diagramType: 'architecture',
      },
    };
  }

  generateDependencyDiagram(analysis: RepoAnalysis): LucidDocument {
    const shapes: LucidShape[] = [];
    const lines: LucidLine[] = [];
    let shapeId = 0;

    const nextId = () => `shape_${shapeId++}`;

    // Title
    const titleId = nextId();
    shapes.push({
      id: titleId,
      type: 'Rectangle',
      text: `📦 ${analysis.repo.name} - Dependencies`,
      x: 350,
      y: 20,
      width: 400,
      height: 60,
      fillColor: '#4A90D9',
      strokeColor: '#2C5F8A',
      fontSize: 16,
    });

    // Group dependencies by type
    const prodDeps = analysis.dependencies.filter(d => d.type === 'production').slice(0, 12);
    const devDeps = analysis.dependencies.filter(d => d.type === 'development').slice(0, 6);

    // Production dependencies
    if (prodDeps.length > 0) {
      const prodTitleId = nextId();
      shapes.push({
        id: prodTitleId,
        type: 'Rectangle',
        text: 'Production Dependencies',
        x: 50,
        y: 120,
        width: 300,
        height: 40,
        fillColor: '#FF6B6B',
        strokeColor: '#CC4444',
        fontSize: 13,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: titleId,
        endShapeId: prodTitleId,
      });

      prodDeps.forEach((dep, i) => {
        const depId = nextId();
        shapes.push({
          id: depId,
          type: 'Rectangle',
          text: `${dep.name}\n${dep.version}`,
          x: 50,
          y: 170 + i * 50,
          width: 300,
          height: 45,
          fillColor: '#FF6B6B',
          strokeColor: '#CC4444',
          fontSize: 11,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: prodTitleId,
          endShapeId: depId,
        });
      });
    }

    // Development dependencies
    if (devDeps.length > 0) {
      const devTitleId = nextId();
      shapes.push({
        id: devTitleId,
        type: 'Rectangle',
        text: 'Development Dependencies',
        x: 450,
        y: 120,
        width: 300,
        height: 40,
        fillColor: '#FFA07A',
        strokeColor: '#CC4444',
        fontSize: 13,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: titleId,
        endShapeId: devTitleId,
      });

      devDeps.forEach((dep, i) => {
        const depId = nextId();
        shapes.push({
          id: depId,
          type: 'Rectangle',
          text: `${dep.name}\n${dep.version}`,
          x: 450,
          y: 170 + i * 50,
          width: 300,
          height: 45,
          fillColor: '#FFA07A',
          strokeColor: '#CC4444',
          fontSize: 11,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: devTitleId,
          endShapeId: depId,
        });
      });
    }

    return {
      title: `${analysis.repo.name} - Dependencies`,
      shapes,
      lines,
      metadata: {
        generatedAt: new Date().toISOString(),
        repoUrl: analysis.repo.full_name,
        diagramType: 'dependencies',
      },
    };
  }

  generateComponentDiagram(analysis: RepoAnalysis): LucidDocument {
    const shapes: LucidShape[] = [];
    const lines: LucidLine[] = [];
    let shapeId = 0;

    const nextId = () => `shape_${shapeId++}`;

    // Title
    const titleId = nextId();
    shapes.push({
      id: titleId,
      type: 'Rectangle',
      text: `🧩 ${analysis.repo.name} - Components`,
      x: 350,
      y: 20,
      width: 400,
      height: 60,
      fillColor: '#00CED1',
      strokeColor: '#008B8B',
      fontSize: 16,
    });

    // Entry points as components
    if (analysis.entryPoints.length > 0) {
      const epTitleId = nextId();
      shapes.push({
        id: epTitleId,
        type: 'Rectangle',
        text: 'Entry Points',
        x: 50,
        y: 120,
        width: 250,
        height: 40,
        fillColor: '#9B59B6',
        strokeColor: '#7B1FA2',
        fontSize: 13,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: titleId,
        endShapeId: epTitleId,
      });

      analysis.entryPoints.forEach((ep, i) => {
        const epId = nextId();
        shapes.push({
          id: epId,
          type: 'Rectangle',
          text: ep.split('/').pop() || ep,
          x: 50,
          y: 170 + i * 50,
          width: 250,
          height: 45,
          fillColor: '#9B59B6',
          strokeColor: '#7B1FA2',
          fontSize: 11,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: epTitleId,
          endShapeId: epId,
        });
      });
    }

    // Key modules
    const modules = analysis.keyFiles.filter(f => f.classes.length > 0 || f.functions.length > 0).slice(0, 8);
    if (modules.length > 0) {
      const modTitleId = nextId();
      shapes.push({
        id: modTitleId,
        type: 'Rectangle',
        text: 'Key Modules',
        x: 350,
        y: 120,
        width: 250,
        height: 40,
        fillColor: '#50C878',
        strokeColor: '#2E8B57',
        fontSize: 13,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: titleId,
        endShapeId: modTitleId,
      });

      modules.forEach((mod, i) => {
        const modId = nextId();
        const exports = [...mod.classes, ...mod.functions.slice(0, 3)].join(', ');
        shapes.push({
          id: modId,
          type: 'Rectangle',
          text: `${mod.path.split('/').pop()}\n${exports.substring(0, 40)}`,
          x: 350,
          y: 170 + i * 50,
          width: 250,
          height: 45,
          fillColor: '#50C878',
          strokeColor: '#2E8B57',
          fontSize: 10,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: modTitleId,
          endShapeId: modId,
        });
      });
    }

    // Languages
    const langEntries = Object.entries(analysis.languages)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 4);

    if (langEntries.length > 0) {
      const langTitleId = nextId();
      shapes.push({
        id: langTitleId,
        type: 'Rectangle',
        text: 'Languages',
        x: 650,
        y: 120,
        width: 200,
        height: 40,
        fillColor: '#FFD700',
        strokeColor: '#B8960F',
        fontSize: 13,
      });

      lines.push({
        id: `line_${shapeId++}`,
        startShapeId: titleId,
        endShapeId: langTitleId,
      });

      langEntries.forEach(([lang, bytes], i) => {
        const langId = nextId();
        shapes.push({
          id: langId,
          type: 'Rectangle',
          text: lang,
          x: 650,
          y: 170 + i * 50,
          width: 200,
          height: 45,
          fillColor: '#FFD700',
          strokeColor: '#B8960F',
          fontSize: 11,
        });
        lines.push({
          id: `line_${shapeId++}`,
          startShapeId: langTitleId,
          endShapeId: langId,
        });
      });
    }

    return {
      title: `${analysis.repo.name} - Components`,
      shapes,
      lines,
      metadata: {
        generatedAt: new Date().toISOString(),
        repoUrl: analysis.repo.full_name,
        diagramType: 'components',
      },
    };
  }

  async createLucidDocument(document: LucidDocument): Promise<string> {
    if (!LUCID_API_KEY) {
      // If no API key, return the document as JSON for display
      return JSON.stringify(document, null, 2);
    }

    try {
      const { data } = await this.axiosInstance.post('/documents', {
        title: document.title,
        type: 'chart',
        shapes: document.shapes.map(s => ({
          type: s.type,
          text: s.text,
          boundingBox: {
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
          },
          style: {
            fillColor: s.fillColor,
            strokeColor: s.strokeColor,
            fontSize: s.fontSize || 12,
          },
        })),
        lines: document.lines.map(l => ({
          startShapeId: l.startShapeId,
          endShapeId: l.endShapeId,
          text: l.text || '',
        })),
      });

      return `Diagram created successfully!\nTitle: ${document.title}\nDocument ID: ${data.id}\nURL: https://lucid.app/lucidchart/${data.id}`;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        throw new McpError(
          ErrorCode.InternalError,
          `Lucid API error: ${error.response?.data?.message || error.message}`
        );
      }
      throw error;
    }
  }
}

// ============================================================
// MCP Server
// ============================================================

class LucidDiagramAgentServer {
  private server: Server;
  private githubAnalyzer: GitHubAnalyzer;
  private lucidGenerator: LucidDiagramGenerator;

  constructor() {
    this.server = new Server(
      {
        name: 'lucid-diagram-agent',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.githubAnalyzer = new GitHubAnalyzer();
    this.lucidGenerator = new LucidDiagramGenerator();

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'analyze_repo',
          description: 'Analyze a GitHub repository structure, languages, dependencies, and architecture without cloning it',
          inputSchema: {
            type: 'object',
            properties: {
              repoUrl: {
                type: 'string',
                description: 'GitHub repository URL or owner/repo format (e.g., "facebook/react" or "https://github.com/facebook/react")',
              },
            },
            required: ['repoUrl'],
          },
        },
        {
          name: 'generate_diagram',
          description: 'Generate a Lucid Chart diagram from a previously analyzed repository',
          inputSchema: {
            type: 'object',
            properties: {
              repoUrl: {
                type: 'string',
                description: 'GitHub repository URL or owner/repo format',
              },
              diagramType: {
                type: 'string',
                description: 'Type of diagram to generate',
                enum: ['architecture', 'dependencies', 'components'],
                default: 'architecture',
              },
            },
            required: ['repoUrl'],
          },
        },
        {
          name: 'analyze_and_diagram',
          description: 'Analyze a GitHub repo and generate a Lucid Chart diagram in one step',
          inputSchema: {
            type: 'object',
            properties: {
              repoUrl: {
                type: 'string',
                description: 'GitHub repository URL or owner/repo format',
              },
              diagramType: {
                type: 'string',
                description: 'Type of diagram to generate',
                enum: ['architecture', 'dependencies', 'components'],
                default: 'architecture',
              },
            },
            required: ['repoUrl'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'analyze_repo':
          return this.handleAnalyzeRepo(request.params.arguments);
        case 'generate_diagram':
          return this.handleGenerateDiagram(request.params.arguments);
        case 'analyze_and_diagram':
          return this.handleAnalyzeAndDiagram(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleAnalyzeRepo(args: any) {
    if (!args?.repoUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'repoUrl is required');
    }

    try {
      const analysis = await this.githubAnalyzer.analyzeRepo(args.repoUrl);
      
      const summary = [
        `# 📊 Repository Analysis: ${analysis.repo.full_name}`,
        '',
        `**Description:** ${analysis.repo.description || 'No description'}`,
        `**Primary Language:** ${analysis.repo.language}`,
        `**Stars:** ⭐ ${analysis.repo.stars} | **Forks:** ${analysis.repo.forks} | **Size:** ${analysis.repo.size} KB`,
        `**Topics:** ${analysis.repo.topics.join(', ') || 'None'}`,
        `**Created:** ${new Date(analysis.repo.created_at).toLocaleDateString()} | **Updated:** ${new Date(analysis.repo.updated_at).toLocaleDateString()}`,
        '',
        '## 🏗️ Architecture',
        `**Type:** ${analysis.architecture.type}`,
        `**Framework:** ${analysis.architecture.framework}`,
        `**Description:** ${analysis.architecture.description}`,
        `**Patterns:** ${analysis.architecture.patterns.join(', ') || 'None detected'}`,
        '',
        '## 📈 Statistics',
        `**Total Files:** ${analysis.stats.totalFiles}`,
        `**Files Analyzed:** ${analysis.keyFiles.length}`,
        `**Estimated Lines:** ${analysis.stats.totalLines.toLocaleString()}`,
        '',
        '## 🔤 Languages',
        ...Object.entries(analysis.languages)
          .sort(([, a], [, b]) => b - a)
          .map(([lang, bytes]) => {
            const total = Object.values(analysis.languages).reduce((a, b) => a + b, 0);
            return `- **${lang}:** ${(bytes / total * 100).toFixed(1)}% (${(bytes / 1024).toFixed(1)} KB)`;
          }),
        '',
        '## 📦 Dependencies',
        `**Total:** ${analysis.dependencies.length}`,
        `**Production:** ${analysis.dependencies.filter(d => d.type === 'production').length}`,
        `**Development:** ${analysis.dependencies.filter(d => d.type === 'development').length}`,
        '',
        '**Top Production Dependencies:**',
        ...analysis.dependencies
          .filter(d => d.type === 'production')
          .slice(0, 10)
          .map(d => `- ${d.name}@${d.version}`),
        '',
        '## 🚪 Entry Points',
        ...(analysis.entryPoints.length > 0
          ? analysis.entryPoints.map(ep => `- \`${ep}\``)
          : ['- No clear entry points detected']),
        '',
        '## 🧩 Key Modules',
        ...analysis.keyFiles
          .filter(f => f.classes.length > 0 || f.functions.length > 0)
          .slice(0, 8)
          .map(f => {
            const items = [...f.classes, ...f.functions.slice(0, 5)];
            return `- \`${f.path}\`: ${items.join(', ')}`;
          }),
      ].join('\n');

      return {
        content: [
          {
            type: 'text',
            text: summary,
          },
        ],
      };
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      return {
        content: [
          {
            type: 'text',
            text: `Error analyzing repository: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGenerateDiagram(args: any) {
    if (!args?.repoUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'repoUrl is required');
    }

    try {
      const analysis = await this.githubAnalyzer.analyzeRepo(args.repoUrl);
      const diagramType = args.diagramType || 'architecture';
      
      let document: LucidDocument;
      switch (diagramType) {
        case 'dependencies':
          document = this.lucidGenerator.generateDependencyDiagram(analysis);
          break;
        case 'components':
          document = this.lucidGenerator.generateComponentDiagram(analysis);
          break;
        case 'architecture':
        default:
          document = this.lucidGenerator.generateArchitectureDiagram(analysis);
          break;
      }
      
      const result = await this.lucidGenerator.createLucidDocument(document);

      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      return {
        content: [
          {
            type: 'text',
            text: `Error generating diagram: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleAnalyzeAndDiagram(args: any) {
    if (!args?.repoUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'repoUrl is required');
    }

    try {
      const analysis = await this.githubAnalyzer.analyzeRepo(args.repoUrl);
      const diagramType = args.diagramType || 'architecture';
      
      let document: LucidDocument;
      switch (diagramType) {
        case 'dependencies':
          document = this.lucidGenerator.generateDependencyDiagram(analysis);
          break;
        case 'components':
          document = this.lucidGenerator.generateComponentDiagram(analysis);
          break;
        case 'architecture':
        default:
          document = this.lucidGenerator.generateArchitectureDiagram(analysis);
          break;
      }
      
      const result = await this.lucidGenerator.createLucidDocument(document);

      const summary = [
        `# ✅ Analysis & Diagram Complete: ${analysis.repo.full_name}`,
        '',
        `**Architecture:** ${analysis.architecture.type}`,
        `**Framework:** ${analysis.architecture.framework}`,
        `**Languages:** ${Object.keys(analysis.languages).join(', ')}`,
        `**Dependencies:** ${analysis.dependencies.length}`,
        `**Patterns:** ${analysis.architecture.patterns.join(', ') || 'None'}`,
        '',
        result,
        '',
        '## 📋 Diagram Structure',
        `- **Shapes:** ${document.shapes.length}`,
        `- **Connections:** ${document.lines.length}`,
        '',
        '### Diagram Sections:',
        '- 📦 Repository Overview',
        '- 🏗️ Architecture Type',
        '- 🔤 Languages Breakdown',
        '- 📦 Dependencies',
        '- 🚪 Entry Points',
        '- 🧩 Key Modules',
        '- 🎯 Design Patterns',
      ].join('\n');

      return {
        content: [
          {
            type: 'text',
            text: summary,
          },
        ],
      };
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Lucid Diagram Agent MCP server running on stdio');
    console.error('Tools available: analyze_repo, generate_diagram, analyze_and_diagram');
    if (!LUCID_API_KEY) {
      console.error('Note: LUCID_API_KEY not set. Diagrams will be returned as JSON instead of created in Lucid.');
    }
  }
}

// ============================================================
// CLI Interface (for direct usage)
// ============================================================

class CLI {
  private analyzer: GitHubAnalyzer;
  private generator: LucidDiagramGenerator;

  constructor() {
    this.analyzer = new GitHubAnalyzer();
    this.generator = new LucidDiagramGenerator();
  }

  async run(args: string[]) {
    const command = args[0];
    const repoUrl = args[1];
    const diagramType = args[2] || 'architecture';
    const outputFile = args[3] || '';

    if (!command || !repoUrl) {
      this.showHelp();
      process.exit(1);
    }

    try {
      switch (command) {
        case 'analyze':
          await this.analyzeCommand(repoUrl);
          break;
        case 'diagram':
          await this.diagramCommand(repoUrl, diagramType, outputFile);
          break;
        case 'full':
          await this.fullCommand(repoUrl, diagramType, outputFile);
          break;
        case 'json':
          await this.jsonCommand(repoUrl, diagramType, outputFile);
          break;
        default:
          console.error(`Unknown command: ${command}`);
          this.showHelp();
          process.exit(1);
      }
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }

  private showHelp() {
    console.log(`
Lucid Diagram Agent - Generate diagrams from GitHub repositories

Usage:
  node build/index.js <repo-url> [diagram-type] [output-file]
  node build/index.js <command> <repo-url> [diagram-type] [output-file]

Commands:
  (none)       - Analyze and generate architecture diagram (default)
  analyze      - Analyze repository structure and display information
  diagram      - Generate a Lucid Chart diagram
  full         - Analyze and generate diagram (combined)
  json         - Generate diagram as JSON (no Lucid API needed)

Arguments:
  repo-url     GitHub repository URL or owner/repo format
  diagram-type Type of diagram: architecture, dependencies, components (default: architecture)
  output-file  Optional: File path to save the diagram/JSON output

Examples:
  node build/index.js facebook/react
  node build/index.js facebook/react dependencies
  node build/index.js facebook/react architecture ./diagram.json
  node build/index.js analyze facebook/react
  node build/index.js diagram facebook/react architecture ./my-diagram.json
  node build/index.js full facebook/react dependencies ./output.json
  node build/index.js json facebook/react components ./diagram.json

Environment Variables:
  LUCID_API_KEY  - Lucid Charts API key (optional, for creating diagrams in Lucid)
  GITHUB_TOKEN   - GitHub personal access token (optional, for higher rate limits)

Note: Without LUCID_API_KEY, diagrams will be output as JSON that can be imported into Lucid Charts.
    `);
  }

  private async analyzeCommand(repoUrl: string) {
    console.error(`Analyzing repository: ${repoUrl}...`);
    const analysis = await this.analyzer.analyzeRepo(repoUrl);
    
    console.log(`\n# 📊 Repository Analysis: ${analysis.repo.full_name}\n`);
    console.log(`**Description:** ${analysis.repo.description || 'No description'}`);
    console.log(`**Primary Language:** ${analysis.repo.language}`);
    console.log(`**Stars:** ⭐ ${analysis.repo.stars} | **Forks:** ${analysis.repo.forks}`);
    console.log(`**Topics:** ${analysis.repo.topics.join(', ') || 'None'}\n`);
    
    console.log('## 🏗️ Architecture');
    console.log(`**Type:** ${analysis.architecture.type}`);
    console.log(`**Framework:** ${analysis.architecture.framework}`);
    console.log(`**Patterns:** ${analysis.architecture.patterns.join(', ') || 'None'}\n`);
    
    console.log('## 🔤 Languages');
    Object.entries(analysis.languages)
      .sort(([, a], [, b]) => b - a)
      .forEach(([lang, bytes]) => {
        const total = Object.values(analysis.languages).reduce((a, b) => a + b, 0);
        console.log(`- **${lang}:** ${(bytes / total * 100).toFixed(1)}%`);
      });
    
    console.log(`\n## 📦 Dependencies (${analysis.dependencies.length} total)`);
    analysis.dependencies.slice(0, 10).forEach(dep => {
      console.log(`- ${dep.name}@${dep.version} (${dep.type})`);
    });
    
    console.log(`\n## 🚪 Entry Points`);
    analysis.entryPoints.forEach(ep => console.log(`- ${ep}`));
  }

  private async diagramCommand(repoUrl: string, diagramType: string, outputFile: string) {
    console.error(`Generating ${diagramType} diagram for: ${repoUrl}...`);
    const analysis = await this.analyzer.analyzeRepo(repoUrl);
    
    let document: LucidDocument;
    switch (diagramType) {
      case 'dependencies':
        document = this.generator.generateDependencyDiagram(analysis);
        break;
      case 'components':
        document = this.generator.generateComponentDiagram(analysis);
        break;
      default:
        document = this.generator.generateArchitectureDiagram(analysis);
    }
    
    const result = await this.generator.createLucidDocument(document);
    
    if (outputFile) {
      fs.writeFileSync(outputFile, result, 'utf-8');
      console.log(`Diagram saved to: ${outputFile}`);
    } else {
      console.log(result);
    }
  }

  private async fullCommand(repoUrl: string, diagramType: string, outputFile: string) {
    console.error(`Analyzing and generating ${diagramType} diagram for: ${repoUrl}...`);
    const analysis = await this.analyzer.analyzeRepo(repoUrl);
    
    let document: LucidDocument;
    switch (diagramType) {
      case 'dependencies':
        document = this.generator.generateDependencyDiagram(analysis);
        break;
      case 'components':
        document = this.generator.generateComponentDiagram(analysis);
        break;
      default:
        document = this.generator.generateArchitectureDiagram(analysis);
    }
    
    const result = await this.generator.createLucidDocument(document);
    
    console.log(`\n# ✅ Analysis Complete: ${analysis.repo.full_name}\n`);
    console.log(`**Architecture:** ${analysis.architecture.type}`);
    console.log(`**Framework:** ${analysis.architecture.framework}`);
    console.log(`**Languages:** ${Object.keys(analysis.languages).join(', ')}`);
    console.log(`**Dependencies:** ${analysis.dependencies.length}\n`);
    
    if (outputFile) {
      fs.writeFileSync(outputFile, result, 'utf-8');
      console.log(`Diagram saved to: ${outputFile}`);
    } else {
      console.log(result);
    }
  }

  private async jsonCommand(repoUrl: string, diagramType: string, outputFile: string) {
    console.error(`Generating ${diagramType} diagram as JSON for: ${repoUrl}...`);
    const analysis = await this.analyzer.analyzeRepo(repoUrl);
    
    let document: LucidDocument;
    switch (diagramType) {
      case 'dependencies':
        document = this.generator.generateDependencyDiagram(analysis);
        break;
      case 'components':
        document = this.generator.generateComponentDiagram(analysis);
        break;
      default:
        document = this.generator.generateArchitectureDiagram(analysis);
    }
    
    const jsonOutput = JSON.stringify(document, null, 2);
    
    if (outputFile) {
      fs.writeFileSync(outputFile, jsonOutput, 'utf-8');
      console.log(`JSON diagram saved to: ${outputFile}`);
    } else {
      console.log(jsonOutput);
    }
  }
}

// ============================================================
// Entry Point
// ============================================================

const isCLI = process.argv[1] === process.argv[1] && process.argv.length > 1;

if (isCLI && process.argv[2]) {
  // CLI mode
  const cli = new CLI();
  
  // If only repo URL is provided (no command), default to full analysis + diagram
  if (process.argv.length === 3 && !['analyze', 'diagram', 'full', 'json', 'help'].includes(process.argv[2])) {
    cli.run(['full', process.argv[2], 'architecture']).catch(console.error);
  } else {
    cli.run(process.argv.slice(2)).catch(console.error);
  }
} else {
  // MCP server mode
  const server = new LucidDiagramAgentServer();
  server.run().catch(console.error);
}
