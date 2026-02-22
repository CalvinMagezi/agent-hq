import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import { createTempVault, cleanupTempVault } from "./helpers";
import type { VaultClient } from "../index";

let vaultPath: string;
let client: VaultClient;

beforeEach(() => {
  const tmp = createTempVault();
  vaultPath = tmp.vaultPath;
  client = tmp.client;
});

afterEach(() => {
  cleanupTempVault(vaultPath);
});

describe("Note CRUD", () => {
  test("createNote creates file with correct frontmatter", async () => {
    const notePath = await client.createNote("Projects", "My Test Note", "This is the content", {
      tags: ["test", "project"],
      pinned: true,
      noteType: "note",
    });

    expect(fs.existsSync(notePath)).toBe(true);

    const raw = fs.readFileSync(notePath, "utf-8");
    expect(raw).toContain("noteType: note");
    expect(raw).toContain("pinned: true");
    expect(raw).toContain("embeddingStatus: pending");
    expect(raw).toContain("This is the content");
  });

  test("readNote returns parsed note object", async () => {
    const notePath = await client.createNote("Memories", "Remember This", "Important fact", {
      tags: ["memory"],
    });

    const note = await client.readNote(notePath);
    expect(note.title).toBe("Remember This");
    expect(note.content).toContain("Important fact");
    expect(note.tags).toEqual(["memory"]);
    expect(note.pinned).toBe(false);
    expect(note.noteType).toBe("note");
    expect(note.embeddingStatus).toBe("pending");
  });

  test("readNote with relative path", async () => {
    await client.createNote("Projects", "Relative Test", "Content");

    const note = await client.readNote("Notebooks/Projects/Relative Test.md");
    expect(note.title).toBe("Relative Test");
    expect(note.content).toContain("Content");
  });

  test("readNote throws for missing note", async () => {
    await expect(client.readNote("nonexistent.md")).rejects.toThrow("Note not found");
  });

  test("updateNote modifies content", async () => {
    const notePath = await client.createNote("Projects", "Update Me", "Original content");

    await client.updateNote(notePath, "Updated content");

    const note = await client.readNote(notePath);
    expect(note.content).toContain("Updated content");
    expect(note.embeddingStatus).toBe("pending"); // Re-marked for embedding
  });

  test("updateNote modifies frontmatter", async () => {
    const notePath = await client.createNote("Projects", "Tag Me", "Content", {
      tags: ["original"],
    });

    await client.updateNote(notePath, undefined, {
      tags: ["original", "added"],
      pinned: true,
    });

    const note = await client.readNote(notePath);
    expect(note.tags).toEqual(["original", "added"]);
    expect(note.pinned).toBe(true);
  });

  test("listNotes returns notes in folder", async () => {
    await client.createNote("Projects", "Project A", "Content A");
    await client.createNote("Projects", "Project B", "Content B");
    await client.createNote("Memories", "Memory A", "Content C");

    const projectNotes = await client.listNotes("Projects");
    expect(projectNotes.length).toBe(2);

    const memoryNotes = await client.listNotes("Memories");
    expect(memoryNotes.length).toBe(1);
  });

  test("listNotes filters by noteType", async () => {
    await client.createNote("Projects", "Note A", "A", { noteType: "note" });
    await client.createNote("Projects", "Digest B", "B", { noteType: "digest" });

    const notes = await client.listNotes("Projects", { noteType: "digest" });
    expect(notes.length).toBe(1);
    expect(notes[0].title).toBe("Digest B");
  });

  test("listNotes filters by pinned", async () => {
    await client.createNote("Projects", "Pinned", "A", { pinned: true });
    await client.createNote("Projects", "Not Pinned", "B", { pinned: false });

    const pinned = await client.listNotes("Projects", { pinned: true });
    expect(pinned.length).toBe(1);
    expect(pinned[0].title).toBe("Pinned");
  });

  test("getPinnedNotes returns only pinned notes across folders", async () => {
    await client.createNote("Projects", "Pinned Project", "A", { pinned: true });
    await client.createNote("Memories", "Pinned Memory", "B", { pinned: true });
    await client.createNote("Projects", "Not Pinned", "C", { pinned: false });

    const pinned = await client.getPinnedNotes();
    expect(pinned.length).toBe(2);
    const titles = pinned.map((n) => n.title).sort();
    expect(titles).toEqual(["Pinned Memory", "Pinned Project"]);
  });

  test("searchNotes finds by title", async () => {
    await client.createNote("Projects", "Machine Learning Guide", "Content about ML");
    await client.createNote("Projects", "Web Design", "Content about CSS");

    const results = await client.searchNotes("machine learning");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Machine Learning Guide");
  });

  test("searchNotes finds by content", async () => {
    await client.createNote("Projects", "Note A", "The quick brown fox jumps");
    await client.createNote("Projects", "Note B", "The lazy dog sleeps");

    const results = await client.searchNotes("brown fox");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Note A");
  });

  test("searchNotes respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await client.createNote("Projects", `Test Note ${i}`, `Test content ${i}`);
    }

    const results = await client.searchNotes("test", 2);
    expect(results.length).toBe(2);
  });

  test("getNotesForEmbedding returns pending notes", async () => {
    await client.createNote("Projects", "Needs Embedding", "Content");
    await client.createNote("Projects", "Already Embedded", "Content");
    // Update second to "embedded"
    const notes = await client.listNotes("Projects");
    const embedded = notes.find((n) => n.title === "Already Embedded");
    if (embedded) {
      await client.updateNote(embedded._filePath, undefined, {
        embeddingStatus: "embedded",
      });
    }

    const pending = await client.getNotesForEmbedding("pending", 10);
    expect(pending.length).toBe(1);
    expect(pending[0].title).toBe("Needs Embedding");
  });
});
