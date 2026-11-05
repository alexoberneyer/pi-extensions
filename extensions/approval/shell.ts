export interface ShellCommand {
  words: string[];
  input: string[];
  upstream?: ShellCommand;
  group?: ShellCommand[];
  nested?: boolean;
}

// A lexical view for the workflow guard, not a complete shell parser or sandbox.
// Keep argument text separate from command positions, and inspect substitutions.
export function shellCommands(source: string): ShellCommand[] {
  const commands: ShellCommand[] = [];

  function scan(text: string, from = 0, closing?: string): number {
    const fresh = (): ShellCommand => ({
      words: [],
      input: [],
      ...(closing ? { nested: true } : {}),
    });
    let command = fresh();
    let word = "";
    let started = false;
    let quote = "";
    let redirect: "skip" | "input" | undefined;
    let heredoc:
      | { tabs: boolean; quoted: boolean; command: ShellCommand }
      | undefined;
    const heredocs: (NonNullable<typeof heredoc> & { delimiter: string })[] =
      [];
    const finishWord = () => {
      if (started) {
        if (heredoc) {
          heredocs.push({ ...heredoc, delimiter: word });
          heredoc = undefined;
        } else if (redirect === "input") command.input.push(word);
        else if (!redirect) command.words.push(word);
        redirect = undefined;
      }
      word = "";
      started = false;
    };
    const finishCommand = () => {
      finishWord();
      const finished = command;
      if (command.words.length || command.group) commands.push(command);
      command = fresh();
      redirect = undefined;
      return finished;
    };

    let i = from;
    for (; i < text.length; i++) {
      const char = text[i];
      if (!quote && char === closing) {
        finishCommand();
        return i + 1;
      }
      if (char === "\\" && quote !== "'") {
        const next = text[i + 1];
        if (next === "\n") i++;
        else if (next && (!quote || /[$`"\\]/.test(next))) {
          if (heredoc) heredoc.quoted = true;
          word += next;
          started = true;
          i++;
        } else {
          word += char;
          started = true;
        }
        continue;
      }
      if (quote === "'") {
        if (char === quote) quote = "";
        else word += char;
        continue;
      }
      if (!heredoc && (char === "`" || (char === "$" && text[i + 1] === "("))) {
        i =
          scan(text, i + (char === "`" ? 1 : 2), char === "`" ? "`" : ")") - 1;
        word += "$(...)";
        started = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = "";
        else word += char;
        continue;
      }
      if (char === "'" || char === '"') {
        if (heredoc) heredoc.quoted = true;
        quote = char;
        started = true;
      } else if (char === "#" && !started) {
        i = text.indexOf("\n", i);
        if (i === -1) break;
        i--;
      } else if (/\s/.test(char)) {
        finishWord();
        if (char !== "\n") continue;
        finishCommand();
        for (const doc of heredocs.splice(0)) {
          const start = i + 1;
          let end = start;
          while (end < text.length) {
            const newline = text.indexOf("\n", end);
            const lineEnd = newline === -1 ? text.length : newline;
            const line = text.slice(end, lineEnd);
            if (
              (doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter
            ) {
              i = lineEnd;
              break;
            }
            end = lineEnd + 1;
          }
          if (end >= text.length) i = text.length;
          const body = text.slice(start, end);
          doc.command.input.push(body);
          if (!doc.quoted) {
            // Unquoted heredocs expand substitutions even for non-shell readers.
            for (let j = 0; j < body.length; j++) {
              if (body[j] === "\\") j++;
              else if (body[j] === "`") j = scan(body, j + 1, "`") - 1;
              else if (body[j] === "$" && body[j + 1] === "(")
                j = scan(body, j + 2, ")") - 1;
            }
          }
        }
      } else if ((char === "<" || char === ">") && text[i + 1] === "(") {
        i = scan(text, i + 2, ")") - 1;
        word += "process-substitution";
        started = true;
      } else if (char === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
        finishWord();
        const tabs = text[i + 2] === "-";
        heredoc = { tabs, quoted: false, command };
        i += tabs ? 2 : 1;
      } else if (char === "<" || char === ">") {
        if (/^\d+$/.test(word)) {
          word = "";
          started = false;
        }
        finishWord();
        redirect = text.slice(i, i + 3) === "<<<" ? "input" : "skip";
        while (/[<>&|]/.test(text[i + 1] ?? "")) i++;
      } else if (/[;&|()]/.test(char)) {
        const finished = finishCommand();
        if (char === "|" && text[i + 1] !== "|") {
          command.upstream = finished;
          if (text[i + 1] === "&") i++;
        } else if (char === "|" && text[i + 1] === "|") i++;
        else if (char === "(") {
          const start = commands.length;
          i = scan(text, i + 1, ")") - 1;
          command.group = commands.slice(start);
        }
      } else {
        word += char;
        started = true;
      }
    }
    finishCommand();
    return i;
  }

  scan(source);
  return commands;
}
