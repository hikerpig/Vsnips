import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { walkSync } from 'walk';
import { getSnipsDirs } from "./kv_store";
import { parse, Snippet } from "./parse";
import { Logger } from "./logger";

export {
  Snippet,
};

type SnipFileEntry = {
  fullPath: string
  /**
   * 相对于 SnipsDir 的路径
   */
  shortPath: string
};

type LanguageSnippetRecord = {
  language: string
  extendedLanguages: Set<string>
  snippets: Snippet[]
};

export class SnippetManager {
  /**
   * 记录某语言已经解析过的 Snippet
   */
  protected languageSnippetRecords = new Map<string, LanguageSnippetRecord>();
  /**
   * All `.snippet` in snips dirs
   */
  protected snipFileEntries: SnipFileEntry[] = [];

  private snippetsIsAdded = new Map<string, Promise<boolean>>();

  public addLanguage(language: string) {
    if (!this.languageSnippetRecords.get(language)) {
      Logger.info("Start repush the", language, "from local dir");

      this.snippetsIsAdded.set(language, new Promise<boolean>((resolve) => {
        vscode.window.setStatusBarMessage("[Vsnips]: Start add language " + language);
        this.doAddLanguageType(language);
        Logger.info(" End  repush the", language, "from local dir");
        vscode.window.setStatusBarMessage("[Vsnips]: End  add language " + language);
        resolve(true);
      }));
    } else {
      Logger.debug(language, "has been added");
    }
  }

  public init() {
    this.refreshSnipFilePaths();
    this.initDefaultLanguage();
  }

  protected initDefaultLanguage() {
    this.addLanguage("all");
  }

  /**
   * 根据语言查询可用 snippets,
   * `all.snippets` 可以被所有语言使用
   */

  public async getSnippets(language: string, opts: { skipDefault?: boolean, extendPath?: string[] } = {}): Promise<Snippet[]> {
    const isAddedPromise = new Promise((resolve, reject) => {
      const isAdded = this.snippetsIsAdded.get(language);
      if(isAdded === undefined) {
        reject("The " + language + " does't add yet");
        return;
      }
      resolve();
    });
    return isAddedPromise.then(async () => {
      const record = this.languageSnippetRecords.get(language);
      const extendPath = opts.extendPath || [];
      let snippetsOfLanguage: Snippet[] = [];
      const extraSnippets: Snippet[] = [];
      if (record) {
        snippetsOfLanguage = record.snippets;
        for (const extendedLanguage of record.extendedLanguages) {
          if (extendPath.includes(extendedLanguage)) {
            continue;
          }
          const extendedLangSnippets = await this.getSnippets(extendedLanguage, {
            skipDefault: true,
            extendPath: [...extendPath, extendedLanguage],
          });
          extraSnippets.push(...extendedLangSnippets);
        }
      }
      if (!(opts.skipDefault || language === 'all')) {
        const snippetsOfAll = await this.getSnippets('all', {
          skipDefault: true,
          extendPath: [...extendPath, language],
        }) || [];
        extraSnippets.push(...snippetsOfAll);
      }
      return extraSnippets.concat(snippetsOfLanguage);
    });
  }

  /**
   * 查找某语言的 snippet 文件需要稍微多一点的 pattern matching （见 doAddLanguageType）
   * 为了避免多次遍历文件系统，此处提前全部遍历一遍，记录所有 snippet 文件路径
   */
  protected refreshSnipFilePaths() {
    const fileEntries: SnipFileEntry[] = [];
    getSnipsDirs().forEach(snipDir => {
      walkSync(snipDir, {
        listeners: {
          names(base, names, next) {
            const relToSnipDir = path.relative(snipDir, base);
            const shouldIgnore = relToSnipDir[0] === "."; // ignore dot files like '.git'
            if (!shouldIgnore) {
              const localEntries = names
                .filter(name => {
                  return path.extname(name) === ".snippets";
                })
                .map(name => {
                  return {
                    fullPath: path.join(base, name),
                    shortPath: path.join(relToSnipDir, name)
                  };
                });
              fileEntries.push(...localEntries);
              next();
            }
          }
        }
      });
    });
    this.snipFileEntries = fileEntries;
  }

  /**
   * 遍历 snips dirs 寻找对应语言的 snippets 文件并解析
   */
  protected doAddLanguageType(fileType: string) {
    const snippets: Snippet[] = [];
    const record: LanguageSnippetRecord = {
      language: fileType,
      snippets,
      extendedLanguages: new Set(),
    };

    const snippetFilePaths = this.snipFileEntries.reduce((out: string[], entry) => {
      let shouldAdd = false;
      const { shortPath, fullPath } = entry;
      if (shortPath.startsWith(fileType)) {
        const rest = shortPath.substr(fileType.length);
        // @see https://github.com/SirVer/ultisnips/blob/master/doc/UltiSnips.txt#L522
        if (["/", "_", "."].includes(rest[0])) {
          shouldAdd = true;
        }
      }
      if (shouldAdd && fs.existsSync(fullPath)) {
        out.push(fullPath);
      }
      return out;
    }, []);

    snippetFilePaths.forEach((snipFile) => {
      const fileContent = fs.readFileSync(snipFile, "utf8");

      // 如果 snippet中有extends语句, 会先添加被继承的语言的 snippet
      try {
        const fileSnippets = parse(fileContent, {
          onExtends: ({ extendedTypes }) => {
            extendedTypes.forEach((typeName) => {
              if (fileType === typeName || record.extendedLanguages.has(typeName)) {
                return;
              }
              record.extendedLanguages.add(typeName);
              this.addLanguage(typeName);
            });
            return [];
          }
        });
        snippets.push(...fileSnippets);
      } catch (error) {
        Logger.error(`Parse ${snipFile} with error: ${error}`);
      }
    });

    // Add the vdoc snippets for current file type, a little ugly.
    const vdocSnipContent = `snippet vdoc "${fileType} doc"\n` +
      `\`!p snip.rv = get_${fileType}_doc(snip)\`\n` +
      `endsnippet`;
    const vdocSnippet = parse(vdocSnipContent)[0];
    snippets.push(vdocSnippet);

    const vboxSnipContent = `snippet vbox "box" w\n` +
        `\`!p snip.rv = get_simple_box(snip)\`\n` +
        `endsnippet`;
    const vboxSnippet = parse(vboxSnipContent)[0];
    snippets.push(vboxSnippet);

    this.languageSnippetRecords.set(fileType, record);
  }
}

export const snippetManager = new SnippetManager();
