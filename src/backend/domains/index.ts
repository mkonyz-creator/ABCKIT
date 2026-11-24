/**
 * Registers every domain's business logic (ported from the PostgreSQL triggers, views and functions).
 * Import order does not matter; each module only calls define*() from ../registry.
 */
import './core'
import './projects'
import './operations'
import './people_finance'
import './analytics'
import './ai'
import './userReports'
