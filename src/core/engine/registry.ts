import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { BotModule, CommandDef, CallbackDef } from "./types";

type Owned<T> = T & { module: BotModule };

/**
 * Daftar semua modul yang terpasang beserta indeks perintah, tombol, dan prefix inline-nya.
 * Modul lain memakainya untuk membangun menu dan bantuan tanpa saling mengenal.
 */
export class ModuleRegistry {
  readonly modules = new Map<string, BotModule>();
  readonly commands = new Map<string, Owned<CommandDef>>();
  readonly callbacks = new Map<string, Owned<CallbackDef>>();
  readonly prefixes = new Map<string, BotModule>();

  /** Muat setiap folder di `modules/` (kecuali yang berawalan `_`). Modul yang gagal dilewati, bot tetap jalan. */
  async loadAll(modulesDir = path.resolve(__dirname, "../../modules")): Promise<void> {
    if (!fs.existsSync(modulesDir)) {
      console.warn(`[Modul] Folder modul tidak ditemukan: ${modulesDir}`);
      return;
    }

    const folders = fs
      .readdirSync(modulesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();

    for (const folder of folders) {
      const file = ["index.js", "index.ts"].map((f) => path.join(modulesDir, folder, f)).find((f) => fs.existsSync(f));
      if (!file) continue;

      try {
        const imported = await import(pathToFileURL(file).href);
        const mod: BotModule | undefined = imported?.default?.default ?? imported?.default;
        if (!mod?.meta?.id) {
          console.warn(`[Modul] ${folder}: tidak mengekspor BotModule sebagai default, dilewati.`);
          continue;
        }
        await mod.onLoad?.();
        this.register(mod);
      } catch (err) {
        console.error(`[Modul] ${folder}: gagal dimuat, dilewati.`, err);
      }
    }

    console.log(`[Modul] ${this.modules.size} modul dimuat: ${[...this.modules.keys()].join(", ")}`);
  }

  /** Daftarkan satu modul. Bentrok ID, perintah, prefix, atau namespace tombol dianggap error. */
  register(mod: BotModule): void {
    const id = mod.meta.id;
    const ns = mod.callbackNs ?? id;
    if (this.modules.has(id)) throw new Error(`ID modul "${id}" sudah dipakai.`);

    const names = (mod.commands ?? []).flatMap((c) => [c.command, ...(c.aliases ?? [])].map((n) => n.toLowerCase()));
    for (const name of names) {
      const taken = this.commands.get(name);
      if (taken) throw new Error(`Perintah /${name} sudah dipakai modul ${taken.module.meta.id}.`);
    }

    const prefixes = mod.inline ? [mod.inline.prefix, ...(mod.inline.aliases ?? [])].map((p) => p.toLowerCase()) : [];
    for (const prefix of prefixes) {
      const taken = this.prefixes.get(prefix);
      if (taken) throw new Error(`Prefix inline ${prefix} sudah dipakai modul ${taken.meta.id}.`);
    }

    for (const cb of mod.callbacks ?? []) {
      const taken = this.callbacks.get(`${ns}:${cb.action}`);
      if (taken) throw new Error(`Tombol ${ns}:${cb.action} sudah dipakai modul ${taken.module.meta.id}.`);
    }

    this.modules.set(id, mod);
    for (const cmd of mod.commands ?? []) {
      for (const name of [cmd.command, ...(cmd.aliases ?? [])]) {
        this.commands.set(name.toLowerCase(), { ...cmd, module: mod });
      }
    }
    for (const prefix of prefixes) this.prefixes.set(prefix, mod);
    for (const cb of mod.callbacks ?? []) this.callbacks.set(`${ns}:${cb.action}`, { ...cb, module: mod });
  }

  get(id: string): BotModule | undefined {
    return this.modules.get(id);
  }

  all(): BotModule[] {
    return [...this.modules.values()];
  }

  /** Modul fitur (bukan sistem), yaitu yang bisa dinyalakan/dimatikan. */
  features(): BotModule[] {
    return this.all().filter((m) => !m.meta.system);
  }

  byPrefix(prefix: string): BotModule | undefined {
    return this.prefixes.get(prefix.toLowerCase());
  }
}

export const registry = new ModuleRegistry();
