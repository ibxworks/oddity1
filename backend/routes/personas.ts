import { Router } from "express";
import { getAllPersonas } from "../lib/persona-registry.js";

const router = Router();

// GET /api/personas — public, no auth required
// Returns list of available public figure personas (slug + displayName only)
router.get("/", (_req, res) => {
  const personas = getAllPersonas().map(({ slug, displayName }) => ({
    slug,
    displayName,
  }));
  res.json(personas);
});

export default router;
