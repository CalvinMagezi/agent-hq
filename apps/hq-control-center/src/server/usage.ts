import { createServerFn } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

export interface DailyUsage {
  date: string
  cost: number
  tokensIn: number
  tokensOut: number
}

export interface ModelUsage {
  model: string
  cost: number
}

export interface UsageResult {
  today: number
  month: number
  budget: number
  dailyTrend: DailyUsage[]
  byModel: ModelUsage[]
}

export const getUsage = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UsageResult> => {
    const budgetPath = path.join(VAULT_PATH, '_system/budget.md')
    let todaySpent = 0
    let monthSpent = 0
    let budget = 50

    if (fs.existsSync(budgetPath)) {
      const { data } = matter(fs.readFileSync(budgetPath, 'utf-8'))
      todaySpent = Number(data?.spentToday ?? 0)
      monthSpent = Number(data?.spentThisMonth ?? 0)
      budget = Number(data?.monthlyBudget ?? 50)
    }

    const dailyTrend: DailyUsage[] = []
    const modelMap = new Map<string, number>()

    const dailyDir = path.join(VAULT_PATH, '_usage/daily')
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir)
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => b.localeCompare(a)) // descending
        .slice(0, 30) // last 30 days
        .reverse() // chronological for charts

      for (const file of files) {
        const date = file.replace('.md', '')
        let cost = 0
        let tokensIn = 0
        let tokensOut = 0

        const content = fs.readFileSync(path.join(dailyDir, file), 'utf-8')
        const lines = content.split('\n')

        for (const line of lines) {
          if (!line.startsWith('- ')) continue
          const parts = line.split('|').map(p => p.trim())
          if (parts.length >= 4) {
            const model = parts[1]
            const tokens = parts[2]
            const costStr = parts[3]

            const inMatch = tokens.match(/in:(\d+)/)
            const outMatch = tokens.match(/out:(\d+)/)
            if (inMatch) tokensIn += parseInt(inMatch[1], 10)
            if (outMatch) tokensOut += parseInt(outMatch[1], 10)

            let lineCost = 0
            if (costStr.startsWith('$')) {
              lineCost = parseFloat(costStr.substring(1))
              cost += lineCost
            }

            modelMap.set(model, (modelMap.get(model) || 0) + lineCost)
          }
        }

        dailyTrend.push({ date, cost, tokensIn, tokensOut })
      }
    }

    const byModel = Array.from(modelMap.entries())
      .map(([model, cost]) => ({ model, cost }))
      .sort((a, b) => b.cost - a.cost)

    return {
      today: todaySpent,
      month: monthSpent,
      budget,
      dailyTrend,
      byModel
    }
  }
)
