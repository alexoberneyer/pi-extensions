// Run off the TUI thread. Project only display metadata, never rollout content.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  db.exec("PRAGMA trusted_schema = OFF");
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(threads)")
      .all()
      .map((row) => row.name),
  );
  if (!["id", "cwd", "updated_at"].every((column) => columns.has(column)))
    throw new Error("Unsupported Codex history schema");
  const optional = (column, expression = column) =>
    `${columns.has(column) ? expression : "NULL"} AS ${column}`;
  const rows = db
    .prepare(
      `
    SELECT id, cwd, updated_at, ${optional("updated_at_ms")},
           ${optional("name", "substr(name, 1, 160)")},
           ${optional("title", "substr(title, 1, 1200)")},
           ${optional("first_user_message", "substr(first_user_message, 1, 1200)")},
           ${optional("preview", "substr(preview, 1, 1200)")},
           ${optional("model", "substr(model, 1, 100)")},
           ${optional("archived")}
    FROM threads
  `,
    )
    .all();
  process.stdout.write(JSON.stringify(rows));
} finally {
  db.close();
}
