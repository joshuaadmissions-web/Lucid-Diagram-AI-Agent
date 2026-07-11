#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
// ============================================================
// Configuration
// ============================================================
const GITHUB_API_BASE = 'https://api.github.com';
const LUCID_API_BASE = 'https://api.lucid.co';
const LUCID_API_KEY = process.env.LUCID_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
// ============================================================
// GitHub Analyzer
// ============================================================
class GitHubAnalyzer {
    axiosInstance;
    constructor() {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'lucid-diagram-agent/1.0',
        };
        if (GITHUB_TOKEN) {
            headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
        }
        this.axiosInstance = axios.create({
            baseURL: GITHUB_API_BASE,
            headers,
        });
    }
    parseRepoUrl(url) {
        // Handle formats: https://github.com/owner/repo, owner/repo, git@github.com:owner/repo.git
        const match = url.match(/(?:https?:\/\/github\.com\/|git@github\.com:)([^\/]+)\/([^\/\.]+)(?:\.git)?\/?$/) || url.match(/^([^\/]+)\/([^\/]+)$/);
        if (!match) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid GitHub URL: ${url}. Expected format: owner/repo or https://github.com/owner/repo`);
        }
        return { owner: match[1], repo: match[2] };
    }
    async getRepoInfo(owner, repo) {
        const { data } = await this.axiosInstance.get(`/repos/${owner}/${repo}`);
        return {
            name: data.name,
            full_name: data.full_name,
            description: data.description || '',
            language: data.language || 'Unknown',
            topics: data.topics || [],
            default_branch: data.default_branch,
            stars: data.stargazers_count,
            forks: data.forks_count,
        };
    }
    async getLanguages(owner, repo) {
        const { data } = await this.axiosInstance.get(`/repos/${owner}/${repo}/languages`);
        return data;
    }
    async getRepoContents(owner, repo, path = '') {
        try {
            const { data } = await this.axiosInstance.get(`/repos/${owner}/${repo}/contents/${path}`);
            if (Array.isArray(data)) {
                return data.map((item) => ({
                    name: item.name,
                    path: item.path,
                    type: item.type,
                    size: item.size,
                }));
            }
            return [];
        }
        catch {
            return [];
        }
    }
    async getFileContent(owner, repo, path) {
        try {
            const { data } = await this.axiosInstance.get(`/repos/${owner}/${repo}/contents/${path}`);
            if (data.content) {
                return Buffer.from(data.content, 'base64').toString('utf-8');
            }
            return '';
        }
        catch {
            return '';
        }
    }
    async getDependencies(owner, repo) {
        const deps = [];
        // Check common dependency files
        const depFiles = [
            'package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
            'Gemfile', 'pom.xml', 'build.gradle', 'CMakeLists.txt',
            'composer.json', 'Pipfile', 'pyproject.toml', 'Cargo.toml'
        ];
        for (const file of depFiles) {
            const content = await this.getFileContent(owner, repo, file);
            if (content) {
                deps.push(...this.parseDependencies(content, file));
            }
        }
        return deps;
    }
    parseDependencies(content, filename) {
        const deps = [];
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
            }
            else if (filename === 'requirements.txt' || filename === 'Pipfile') {
                const lines = content.split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('[')) {
                        const parts = trimmed.split(/[=<>~!]/);
                        deps.push({ name: parts[0].trim(), version: parts[1]?.trim() || '*', type: 'production' });
                    }
                }
            }
            else if (filename === 'Cargo.toml') {
                const lines = content.split('\n');
                let inDeps = false;
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('[dependencies]'))
                        inDeps = true;
                    else if (trimmed.startsWith('[') && !trimmed.startsWith('[dependencies.'))
                        inDeps = false;
                    else if (inDeps && trimmed && !trimmed.startsWith('#')) {
                        const parts = trimmed.split('=');
                        deps.push({ name: parts[0].trim(), version: parts[1]?.trim().replace(/["\s]/g, '') || '*', type: 'production' });
                    }
                }
            }
        }
        catch {
            // Skip unparseable files
        }
        return deps;
    }
    async analyzeFile(owner, repo, path) {
        const content = await this.getFileContent(owner, repo, path);
        if (!content)
            return null;
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const languageMap = {
            'js': 'JavaScript', 'jsx': 'JavaScript', 'ts': 'TypeScript', 'tsx': 'TypeScript',
            'py': 'Python', 'java': 'Java', 'rb': 'Ruby', 'go': 'Go', 'rs': 'Rust',
            'php': 'PHP', 'swift': 'Swift', 'kt': 'Kotlin', 'scala': 'Scala',
        };
        const language = languageMap[ext] || ext;
        const imports = [];
        const exports = [];
        const classes = [];
        const functions = [];
        // Extract imports
        const importRegexes = [
            /import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/g,
            /from\s+['"]([^'"]+)['"]/g,
            /require\(['"]([^'"]+)['"]\)/g,
            /import\s+([^\s;]+)/g,
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
        };
    }
    async analyzeRepo(url) {
        const { owner, repo } = this.parseRepoUrl(url);
        // Get basic info
        const repoInfo = await this.getRepoInfo(owner, repo);
        const languages = await this.getLanguages(owner, repo);
        const dependencies = await this.getDependencies(owner, repo);
        // Get top-level structure
        const structure = await this.getRepoContents(owner, repo);
        // Analyze key files
        const keyPaths = ['src', 'lib', 'app', 'server', 'client', 'backend', 'frontend'];
        const keyFiles = [];
        const entryPoints = [];
        // Check common entry points
        const entryCandidates = [
            'index.js', 'index.ts', 'app.js', 'app.ts', 'main.js', 'main.ts',
            'server.js', 'server.ts', 'index.py', 'main.py', 'app.py',
            'main.go', 'main.rs', 'lib.rs', 'index.html',
        ];
        for (const file of structure) {
            if (file.type === 'file' && entryCandidates.includes(file.name)) {
                entryPoints.push(file.path);
                const analysis = await this.analyzeFile(owner, repo, file.path);
                if (analysis)
                    keyFiles.push(analysis);
            }
        }
        // Analyze key directories
        for (const dir of keyPaths) {
            const dirContent = await this.getRepoContents(owner, repo, dir);
            for (const item of dirContent.slice(0, 15)) {
                if (item.type === 'file') {
                    const analysis = await this.analyzeFile(owner, repo, item.path);
                    if (analysis)
                        keyFiles.push(analysis);
                }
            }
        }
        // Determine architecture type
        const allDeps = dependencies.map(d => d.name.toLowerCase());
        const allImports = keyFiles.flatMap(f => f.imports.map(i => i.toLowerCase()));
        const allContext = [...allDeps, ...allImports];
        let archType = 'Monolithic';
        let framework = 'Unknown';
        let archDescription = '';
        if (allContext.some(d => d.includes('react') || d.includes('vue') || d.includes('angular'))) {
            if (allContext.some(d => d.includes('next'))) {
                archType = 'Full-Stack Framework';
                framework = 'Next.js';
            }
            else if (allContext.some(d => d.includes('express') || d.includes('fastify'))) {
                archType = 'Full-Stack (Frontend + API)';
                framework = allContext.find(d => d.includes('react')) ? 'React + Express' : 'Frontend Framework + API';
            }
            else {
                archType = 'SPA (Single Page Application)';
                framework = allContext.find(d => d.includes('react')) ? 'React' :
                    allContext.find(d => d.includes('vue')) ? 'Vue.js' : 'Angular';
            }
        }
        else if (allContext.some(d => d.includes('express') || d.includes('koa') || d.includes('fastify'))) {
            archType = 'API Server';
            framework = allContext.find(d => d.includes('express')) ? 'Express.js' :
                allContext.find(d => d.includes('fastify')) ? 'Fastify' : 'Koa.js';
        }
        else if (allContext.some(d => d.includes('django') || d.includes('flask') || d.includes('fastapi'))) {
            archType = 'Web Framework';
            framework = allContext.find(d => d.includes('django')) ? 'Django' :
                allContext.find(d => d.includes('fastapi')) ? 'FastAPI' : 'Flask';
        }
        else if (allContext.some(d => d.includes('spring') || d.includes('jakarta'))) {
            archType = 'Enterprise Application';
            framework = 'Spring Boot';
        }
        else if (allContext.some(d => d.includes('tensorflow') || d.includes('pytorch') || d.includes('keras'))) {
            archType = 'Machine Learning';
            framework = allContext.find(d => d.includes('tensorflow')) ? 'TensorFlow' : 'PyTorch';
        }
        const langSummary = Object.entries(languages)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([lang, bytes]) => `${lang} (${(bytes / Object.values(languages).reduce((a, b) => a + b, 0) * 100).toFixed(1)}%)`)
            .join(', ');
        archDescription = `${repoInfo.name} is a ${archType.toLowerCase()} project built primarily with ${langSummary}. `;
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
            },
        };
    }
}
// ============================================================
// Lucid Charts Diagram Generator
// ============================================================
class LucidDiagramGenerator {
    axiosInstance;
    constructor() {
        this.axiosInstance = axios.create({
            baseURL: LUCID_API_BASE,
            headers: {
                'Authorization': `Bearer ${LUCID_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });
    }
    generateArchitectureDiagram(analysis) {
        const shapes = [];
        const lines = [];
        let shapeId = 0;
        const shapeMap = new Map(); // name -> id
        const nextId = () => `shape_${shapeId++}`;
        const COLORS = {
            repo: '#4A90D9',
            lang: '#50C878',
            deps: '#FF6B6B',
            arch: '#FFD700',
            entry: '#9B59B6',
            module: '#00CED1',
        };
        // Title / Repo box
        const repoId = nextId();
        shapeMap.set('repo', repoId);
        shapes.push({
            id: repoId,
            type: 'Rectangle',
            text: `📦 ${analysis.repo.name}\n${analysis.repo.description?.substring(0, 60) || ''}`,
            x: 300,
            y: 20,
            width: 400,
            height: 80,
            fillColor: COLORS.repo,
            strokeColor: '#2C5F8A',
        });
        // Architecture type box
        const archId = nextId();
        shapeMap.set('arch', archId);
        shapes.push({
            id: archId,
            type: 'Rectangle',
            text: `🏗️ Architecture: ${analysis.architecture.type}\nFramework: ${analysis.architecture.framework}`,
            x: 300,
            y: 120,
            width: 400,
            height: 70,
            fillColor: COLORS.arch,
            strokeColor: '#B8960F',
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
            });
            lines.push({
                id: `line_${shapeId++}`,
                startShapeId: langTitleId,
                endShapeId: langId,
            });
        });
        // Dependencies section
        const prodDeps = analysis.dependencies.filter(d => d.type === 'production').slice(0, 8);
        const devDeps = analysis.dependencies.filter(d => d.type === 'development').slice(0, 4);
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
                });
                lines.push({
                    id: `line_${shapeId++}`,
                    startShapeId: moduleTitleId,
                    endShapeId: modId,
                });
            });
        }
        return {
            title: `${analysis.repo.name} - Architecture Diagram`,
            shapes,
            lines,
        };
    }
    async createLucidDocument(document) {
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
                    },
                })),
                lines: document.lines.map(l => ({
                    startShapeId: l.startShapeId,
                    endShapeId: l.endShapeId,
                    text: l.text || '',
                })),
            });
            return `Diagram created successfully!\nTitle: ${document.title}\nDocument ID: ${data.id}\nURL: https://lucid.app/lucidchart/${data.id}`;
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                throw new McpError(ErrorCode.InternalError, `Lucid API error: ${error.response?.data?.message || error.message}`);
            }
            throw error;
        }
    }
}
// ============================================================
// MCP Server
// ============================================================
class LucidDiagramAgentServer {
    server;
    githubAnalyzer;
    lucidGenerator;
    constructor() {
        this.server = new Server({
            name: 'lucid-diagram-agent',
            version: '1.0.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.githubAnalyzer = new GitHubAnalyzer();
        this.lucidGenerator = new LucidDiagramGenerator();
        this.setupToolHandlers();
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    setupToolHandlers() {
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
                    description: 'Generate a Lucid Chart architecture diagram from a previously analyzed repository',
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
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async handleAnalyzeRepo(args) {
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
                `**Stars:** ⭐ ${analysis.repo.stars} | **Forks:** ${analysis.repo.forks}`,
                `**Topics:** ${analysis.repo.topics.join(', ') || 'None'}`,
                '',
                '## 🏗️ Architecture',
                `**Type:** ${analysis.architecture.type}`,
                `**Framework:** ${analysis.architecture.framework}`,
                `**Description:** ${analysis.architecture.description}`,
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
        }
        catch (error) {
            if (error instanceof McpError)
                throw error;
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
    async handleGenerateDiagram(args) {
        if (!args?.repoUrl) {
            throw new McpError(ErrorCode.InvalidParams, 'repoUrl is required');
        }
        try {
            const analysis = await this.githubAnalyzer.analyzeRepo(args.repoUrl);
            const document = this.lucidGenerator.generateArchitectureDiagram(analysis);
            const result = await this.lucidGenerator.createLucidDocument(document);
            return {
                content: [
                    {
                        type: 'text',
                        text: result,
                    },
                ],
            };
        }
        catch (error) {
            if (error instanceof McpError)
                throw error;
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
    async handleAnalyzeAndDiagram(args) {
        if (!args?.repoUrl) {
            throw new McpError(ErrorCode.InvalidParams, 'repoUrl is required');
        }
        try {
            const analysis = await this.githubAnalyzer.analyzeRepo(args.repoUrl);
            const document = this.lucidGenerator.generateArchitectureDiagram(analysis);
            const result = await this.lucidGenerator.createLucidDocument(document);
            const summary = [
                `# ✅ Analysis & Diagram Complete: ${analysis.repo.full_name}`,
                '',
                `**Architecture:** ${analysis.architecture.type}`,
                `**Framework:** ${analysis.architecture.framework}`,
                `**Languages:** ${Object.keys(analysis.languages).join(', ')}`,
                `**Dependencies:** ${analysis.dependencies.length}`,
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
            ].join('\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: summary,
                    },
                ],
            };
        }
        catch (error) {
            if (error instanceof McpError)
                throw error;
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
const server = new LucidDiagramAgentServer();
server.run().catch(console.error);
//# sourceMappingURL=index.js.map