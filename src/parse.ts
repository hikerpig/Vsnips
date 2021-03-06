import * as vscode from 'vscode';
import { Logger } from "./logger";
import { VSnipContext } from "./vsnip_context";
import * as ScriptFunc from "./script_tpl";
import { trim } from './util';
import UNSNIPS_ULTISNIPS from "@unisnips/ultisnips";
import { SnippetDefinition, applyReplacements, PlaceholderReplacement, ParseOptions } from "@unisnips/core";

class Snippet {
  // Please refer to: https://github.com/SirVer/ultisnips/blob/master/doc/UltiSnips.txt
  public prefix: string;
  public body: string;
  public descriptsion: string;
  public vimOptions: string;

  definition!: SnippetDefinition;

  // 标记snip中是否有js函数, 如果有js占位函数的, 需要在补全时再进行一次求值操作
  // 将body体中的js函数进行求值处理.
  public hasJSScript: boolean;

  private isChanging: boolean;

  constructor(prefix="",  description="",  options="", body="", hasJSScript=false,) {
    this.prefix = prefix;
    this.body = body;
    this.descriptsion = description;
    this.hasJSScript = hasJSScript;
    this.vimOptions = options;
    this.isChanging = false;

    Logger.debug(`prefix:  "${this.prefix}"`);
    Logger.debug(`description: "${this.descriptsion}"`);
    Logger.debug(`options: "${this.vimOptions}"`);
    Logger.debug("body: ", this.body);
    Logger.debug("hasJSScript: ", this.hasJSScript);
  }
  public isAutoTriggered() {
    return this.vimOptions.includes("A");
  }
  public isWordBoundary() {
    return this.vimOptions.includes("w");
  }

  // i   In-word expansion - By default a snippet is expanded only if the tab
  //   trigger is the first word on the line or is preceded by one or more
  //   whitespace characters. A snippet with this option is expanded
  //   regardless of the preceding character. In other words, the snippet can
  //   be triggered in the middle of a word.
  public isInWordExpansion() {
    return this.vimOptions.includes("i");
  }

  public get_snip_body(vsContext: VSnipContext) {
    let rlt = "";
    if (this.hasJSScript) {
      rlt = jsFuncEval(this.body, vsContext);
    } else {
      rlt = this.body;
    }
    Logger.debug("Get snippet", rlt);
    return rlt;
  }

  /**
   * 获取由自动触发生成的snip, 不管你有没有看懂代码, 任何修改都建议重写一份
   * vsContext (VSnipContext): TODO
   * editor (vscode.TextEditor): TODO
   * Returns: TODO
   */
  public get_snip_in_auto_triggered(vsContext: VSnipContext, editor: vscode.TextEditor): boolean {
    if (this.isChanging) { // 防止出现修改死循环
      this.isChanging = false;
      return false;
    }
    Logger.debug("Start check", this.prefix, "Get currently context", vsContext);
    const curLine = trim(vsContext.getTextByShift(-1), ['\n']);
    Logger.debug("Get txt", curLine);
    if(this.isWordBoundary()) { // 必须完整出现字符串
      if(!curLine.includes(this.prefix)) {
        Logger.warn("The ", this.prefix, "must have all prefix");
        return false;
      }
      if(this.isInWordExpansion()) { // 必须出现在开头或是一行的中间, 且字符串后面有空格
        const offset = vsContext.position.character;
        if (curLine[offset + 1] !== " " && curLine.length > this.prefix.length) {
          Logger.warn("Can't make snip with options 'i'", curLine, this.prefix);
          return false;
        }
      }
    } else {
      // 这里直接返回的主要原因是防止有人误用'A'这一选项,
      // 有可能会导致vscode出现不可预知的问题.
      Logger.warn("The snip", this, "must with options 'w'");
      return false;
    }

    const rlt = this.get_snip_body(vsContext);
    if(rlt === "") { // 必须获取到对应的结果
      return false;
    }

    const pos = vsContext.position;
    let content = rlt;
    let range = new vscode.Range(
      new vscode.Position(pos.line, pos.character - this.prefix.length+1),
      new vscode.Position(pos.line, pos.character + 1),
    );
    Logger.debug("Start change range", range);

    editor.insertSnippet(new vscode.SnippetString(content), range, { undoStopBefore: false, undoStopAfter: false });
    this.isChanging = true;

    return true;
  }
}

function parse(rawSnippets: string, opts: ParseOptions = {}): Array<Snippet> {
  let snips: Array<Snippet> = [];
  const { definitions } = UNSNIPS_ULTISNIPS.parse(rawSnippets, opts);
  definitions.forEach(def => {
    const snip = new Snippet(def.trigger, def.description, def.flags, def.body);
    snips.push(snip);
    snip.definition = def;
    replacePlaceholderScript(snip);

    Logger.debug("prefix: ", snip.prefix);
    Logger.debug("description: ", snip.descriptsion);
    Logger.debug("body: ", snip.body);
  });
  return snips;
}

// 这部分代码用于实现从vim 或是 python函数 => js函数的转换
// 主要应用了正则替换.
function replacePlaceholderScript(snip: Snippet) {
  // 记录需要替换的值, 最后统一替换, 这里一定要注意, 不要exec之后马上替换,
  // js的实现有问题, 直接替换会导致之后的匹配出现问题, 需要等到所有待替换的值
  // 全部找出后再一起替换.
  const replacements: PlaceholderReplacement[] = [];

  let hasJSScript = false;

  snip.definition.placeholders.forEach(placeholder => {
    if (placeholder.valueType === "script") {
      let replacement: PlaceholderReplacement | null = null;
      const { scriptInfo } = placeholder;
      if (scriptInfo) {
        if (scriptInfo.scriptType === "python") {
          replacement = {
            placeholder,
            type: "string",
            replaceContent: pythonRewrite(scriptInfo.code)
          };
        } else if (scriptInfo.scriptType === "vim") {
          replacement = {
            placeholder,
            type: "string",
            replaceContent: vimRewrite(scriptInfo.code)
          };
        } else if (scriptInfo.scriptType === "js") {
          hasJSScript = true;
        }
      }
      if (replacement) {
        const rlt = replacement.replaceContent;
        if (rlt && rlt.startsWith(`\`!js`)) {
          hasJSScript = true;
        }
        replacements.push(replacement);
      }
    }
  });

  snip.body = applyReplacements(snip.definition, replacements);
  snip.hasJSScript = hasJSScript;
}

function pythonRewrite(stmt: string) {
  // 用于处理这一类字符串: `!p snip.rv = get_quoting_style(snip)`
  Logger.debug("Wanna rewrite python", stmt);

  const funcNamePattern = /(\w+)\(snip\)/;

  if (funcNamePattern.test(stmt)) {
    const [, funcName] = funcNamePattern.exec(stmt) as RegExpExecArray;
    Logger.debug("Get func name", funcName);
    const func = ScriptFunc.getTemplateFunc(funcName);
    if (func === undefined) {
      Logger.warn("Can't get function", funcName, "please check");
      return "";
    }

    try {
      return func();
    } catch (e) {
      Logger.error("In python func:", funcName, ", has error", e);
      return "";
    }
  }

  return stmt;
}

function vimRewrite(stmt: string) {
  // 用于处理这一类字符串: `!v g:snips_author`
  Logger.debug("Wanna rewrite vim", stmt);

  // 匹配时间打印函数
  const timeFuncPattern = /strftime\("(.+)"\)/;
  const variablePattern = /g:(\w*)/;
  const expandPattern = /expand\(['"](.+)['"]\)/;

  if (timeFuncPattern.test(stmt)) {
    const [, tFmt] = timeFuncPattern.exec(stmt) as RegExpExecArray;
    let timeFmt = tFmt;
    Logger.debug("Get time fmt", timeFmt);
    // Please refer to:
    //   https://code.visualstudio.com/docs/editor/userdefinedsnippets#_variables
    const replaceTable = [
      ["%Y", "$CURRENT_YEAR"],
      ["%B", "$CURRENT_MONTH_NAME"],
      ["%b", "$CURRENT_MONTH_NAME_SHORT"],
      ["%m", "$CURRENT_MONTH"],
      ["%d", "$CURRENT_DATE"],
      ["%H", "$CURRENT_HOUR"],
      ["%M", "$CURRENT_MINUTE"],
      ["%S", "$CURRENT_SECOND"],
    ];
    replaceTable.forEach((timeFunc) => {
      const [vimTimeFunc, vscodeTimeFunc] = timeFunc;
      timeFmt = timeFmt.replace(vimTimeFunc, vscodeTimeFunc);
    });
    stmt = timeFmt;
  } else if (variablePattern.test(stmt)) {
    const [, variableName] = variablePattern.exec(stmt) as RegExpExecArray;
    Logger.debug("Get var", variableName);
    stmt = ScriptFunc.getVimVar(variableName);
  } else if (expandPattern.test(stmt)) {
    const [, expandExpr] = expandPattern.exec(stmt) as RegExpExecArray;
    Logger.debug("Get expand expr", expandExpr);
    let func = ScriptFunc.getTemplateFunc('get_vim_expand');
    try {
      stmt = func(expandExpr);
    } catch (error) {
        Logger.error("Process vim expand", error);
    }
  } else {
    Logger.warn("Can't parse", stmt);
  }

  return stmt;
}

// 获得snip中的js函数, 并调用该函数名对应的函数指针.
function jsFuncEval(snip: string, vsContext: VSnipContext) {
  Logger.info("In js Func eval");

  let res = null;
  // eslint-disable-next-line
  const JS_SNIP_FUNC_PATTERN = /`!js (\w+)(\(.*\))?\`/g;

  while ((res = JS_SNIP_FUNC_PATTERN.exec(snip)) !== null) {
    const [pattern, funcName, funcArgs] = res as RegExpExecArray;
    Logger.info("Get js func", pattern, funcName, funcArgs);
    // let func = (ScriptFunc as any)[func_name as string];
    const func = ScriptFunc.getTemplateFunc(funcName);
    if (func === null) {
      Logger.warn("Can't get js function", funcName, "please check");
      return snip;
    }
    let funcRlt = "";

    const funcWithCtx = func.bind(undefined, vsContext); // 没有this且默认第一个参数为vsContext
    const stmt = `funcWithCtx(${funcArgs})`;
    Logger.debug("Get func", stmt, funcWithCtx);
    try {
      // eslint-disable-next-line
      funcRlt = eval(stmt);
    } catch (e) {
      Logger.error("In js func", e.message);
      return snip;
    }
    snip = snip.replace(pattern, funcRlt);
  }
  return snip;
}

export { parse, Snippet };
