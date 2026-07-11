# Lucid Diagram Agent

An AI agent that analyzes GitHub repositories and generates architecture diagrams in Lucid Charts. This tool can work as both an MCP (Model Context Protocol) server and a standalone CLI tool.

## Features

- **Repository Analysis**: Analyzes GitHub repositories without cloning them
- **Multiple Diagram Types**:
  - Architecture diagrams (shows project structure, frameworks, patterns)
  - Dependency diagrams (visualizes production and dev dependencies)
  - Component diagrams (displays entry points and key modules)
- **Smart Detection**: Automatically detects:
  - Programming languages and their usage percentages
  - Architecture patterns (SPA, Full-Stack, API Server, etc.)
  - Frameworks and technologies
  - Entry points and key modules
  - Design patterns
- **Dual Mode**: Works as both MCP server and CLI tool
- **No Lucid API Required**: Generates JSON output that can be imported into Lucid Charts

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd lucid-diagram-agent

# Install dependencies
npm install

# Build the project
npm run build
```

## Usage

### CLI Mode

The agent can be used directly from the command line. **Simply provide a GitHub repository URL and it will automatically analyze and generate an architecture diagram!**

```bash
# Just provide repo URL - automatically analyzes and generates architecture diagram
node build/index.js facebook/react

# Specify diagram type
node build/index.js facebook/react dependencies

# Save output to file
node build/index.js facebook/react architecture ./diagram.json

# Use explicit commands
node build/index.js analyze facebook/react
node build/index.js diagram facebook/react architecture
node build/index.js full facebook/react dependencies
node build/index.js json facebook/react components
```

#### CLI Commands

- `(none)` - Just provide repo URL to analyze and generate architecture diagram (default)
- `analyze <repo-url>` - Analyze repository structure and display information
- `diagram <repo-url> [type]` - Generate a Lucid Chart diagram
- `full <repo-url> [type]` - Analyze and generate diagram (combined)
- `json <repo-url> [type]` - Generate diagram as JSON (no Lucid API needed)

#### Arguments

- `repo-url` - GitHub repository URL or owner/repo format (e.g., "facebook/react" or "https://github.com/facebook/react")
- `diagram-type` - Type of diagram to generate:
  - `architecture` (default) - Shows project architecture, languages, dependencies, entry points, and key modules
  - `dependencies` - Shows production and development dependencies
  - `components` - Shows entry points, key modules, and languages
- `output-file` - Optional: File path to save the diagram/JSON output (e.g., `./diagram.json`)

### MCP Server Mode

The agent can also run as an MCP server for integration with AI assistants:

```bash
# Start the MCP server
npm start
```

The server provides three tools:

1. **analyze_repo**: Analyze a GitHub repository structure, languages, dependencies, and architecture
2. **generate_diagram**: Generate a Lucid Chart diagram from a repository
3. **analyze_and_diagram**: Analyze a repo and generate a diagram in one step

## Environment Variables

- `LUCID_API_KEY` - Lucid Charts API key (optional, for creating diagrams directly in Lucid)
- `GITHUB_TOKEN` - GitHub personal access token (optional, for higher rate limits)

### Getting a Lucid API Key

1. Go to [Lucid Developer Portal](https://developer.lucid.co/)
2. Create an account or sign in
3. Create a new application
4. Copy your API key
5. Set it as an environment variable: `export LUCID_API_KEY=your_key_here`

### Getting a GitHub Token

1. Go to [GitHub Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Generate a new token
3. Select the `public_repo` scope for public repositories
4. Copy the token
5. Set it as an environment variable: `export GITHUB_TOKEN=your_token_here`

## Examples

### Quick Start - Just Provide a Repo URL

```bash
$ node build/index.js facebook/react

Analyzing and generating architecture diagram for: facebook/react...

# ✅ Analysis Complete: facebook/react

**Architecture:** SPA (Single Page Application)
**Framework:** React
**Languages:** JavaScript, Rust, TypeScript, HTML, CSS, CoffeeScript, Shell
**Dependencies:** 114

{
  "title": "react - Architecture Diagram",
  "shapes": [
    {
      "id": "shape_0",
      "type": "Rectangle",
      "text": "📦 react\nThe library for web and native user interfaces.",
      "x": 350,
      "y": 20,
      "width": 400,
      "height": 80,
      "fillColor": "#4A90D9",
      "strokeColor": "#2C5F8A",
      "fontSize": 14
    },
    ...
  ],
  "lines": [...],
  "metadata": {
    "generatedAt": "2024-01-15T10:30:00.000Z",
    "repoUrl": "facebook/react",
    "diagramType": "architecture"
  }
}
```

### Save Diagram to File

```bash
$ node build/index.js facebook/react architecture ./my-diagram.json

Analyzing and generating architecture diagram for: facebook/react...
Diagram saved to: ./my-diagram.json
```

### Analyze a Repository

```bash
$ node build/index.js analyze facebook/react

# 📊 Repository Analysis: facebook/react

**Description:** A declarative, efficient, and flexible JavaScript library for building user interfaces.
**Primary Language:** JavaScript
**Stars:** ⭐ 225000 | **Forks:** 46000
**Topics:** react, javascript, library, ui, frontend

## 🏗️ Architecture
**Type:** Full-Stack Framework
**Framework:** Next.js
**Patterns:** SSR/SSG, React, GraphQL, TypeScript

## 🔤 Languages
- **JavaScript:** 45.2%
- **TypeScript:** 38.7%
- **CSS:** 12.1%
...
```

### Generate Different Diagram Types

```bash
# Generate dependencies diagram
$ node build/index.js facebook/react dependencies

# Generate components diagram
$ node build/index.js facebook/react components

# Generate as JSON file
$ node build/index.js json facebook/react architecture ./diagram.json
```

## How It Works

1. **Repository Analysis**: The agent fetches repository information from GitHub's API, including:
   - Basic info (name, description, language, stars, etc.)
   - Language breakdown
   - Dependencies from various package managers
   - Repository structure
   - Key files and their contents

2. **Smart Detection**: The agent analyzes file contents to detect:
   - Architecture patterns (SPA, Full-Stack, API Server, etc.)
   - Frameworks and technologies
   - Design patterns
   - Entry points
   - Key modules and their exports

3. **Diagram Generation**: Based on the analysis, the agent generates a Lucid Chart document with:
   - Shapes representing different components
   - Lines connecting related elements
   - Color-coded sections for easy navigation

4. **Output**: The diagram can be:
   - Created directly in Lucid Charts (with API key)
   - Exported as JSON for manual import
   - Saved to a file for later use
   - Displayed in MCP-compatible AI assistants

## Output Options

- **Console output** (default): Diagram JSON is printed to stdout
- **File output**: Provide a file path as the last argument to save the diagram
  ```bash
  node build/index.js facebook/react architecture ./diagram.json
  ```
- **Lucid Charts**: Set `LUCID_API_KEY` environment variable to create diagrams directly in Lucid

## Project Structure

```
lucid-diagram-agent/
├── src/
│   └── index.ts          # Main application code
├── build/
│   └── index.js          # Compiled JavaScript
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── .gitignore           # Git ignore rules
└── README.md            # This file
```

## Architecture

The project consists of three main components:

1. **GitHubAnalyzer**: Handles all GitHub API interactions and repository analysis
2. **LucidDiagramGenerator**: Generates Lucid Chart documents from analysis results
3. **LucidDiagramAgentServer**: MCP server that exposes tools for AI assistants
4. **CLI**: Command-line interface for direct usage

## Supported Languages

The agent can analyze repositories written in:
- JavaScript/TypeScript
- Python
- Java
- Ruby
- Go
- Rust
- PHP
- Swift
- Kotlin
- Scala
- C/C++
- C#

## Supported Package Managers

- npm/yarn (package.json)
- pip (requirements.txt, Pipfile, pyproject.toml)
- Cargo (Cargo.toml)
- Go modules (go.mod)
- Ruby (Gemfile)
- Maven (pom.xml)
- Gradle (build.gradle)
- CMake (CMakeLists.txt)
- PHP (composer.json)

## Limitations

- GitHub API rate limits apply (60 requests/hour without token, 5000 with token)
- Only analyzes public repositories by default (private repos require token)
- Maximum 50 files analyzed per repository to avoid timeouts
- Diagram complexity is limited to maintain readability

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

ISC

## Acknowledgments

- Built with [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk)
- Uses [Lucid Charts API](https://developer.lucid.co/)
- Powered by [Axios](https://axios-http.com/) for HTTP requests