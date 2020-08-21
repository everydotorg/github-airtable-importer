const Octokit = require('@octokit/rest')
const Airtable = require('airtable')
const ora = require('ora')
const chalk = require('chalk')

const log = console.log

async function githubAirtableImport(options) {
  validateOptions(options)
  const octokit = new Octokit({
    auth: options.githubToken,
  })

  const [owner, repo] = options.githubUrl.split('/')

  async function fetchGithubIssues() {
    try {
      const octokitOptions = octokit.issues.listForRepo.endpoint.merge({
        owner,
        repo,
        per_page: 100,
        state: options.state,
      })
      const data = await octokit.paginate(octokitOptions)
      return data.filter((issue) => !issue.pull_request)
    } catch (err) {
      spinner.fail(
        `Failed to fetch issues from ${chalk.underline(options.githubUrl)}\n`
      )
      log(chalk.red(err))
    }
  }

  async function importIssuesToAirtable(issues) {
    const airtableBase = new Airtable({ apiKey: options.airtableApiKey }).base(
      options.airtableBase
    )

    try {
      const allIssues = issues.map(
        ({
          created_at,
          updated_at,
          title,
          body,
          html_url,
          number,
          labels,
          assignee,
          state,
        }) => ({
          fields: {
            'Created At': created_at,
            'Updated At': updated_at,
            'Issue Number': number,
            Name: title,
            Description: body,
            'Github URL': html_url,
            Labels: labels.map((l) => l.name).join(','),
            Status: state,
            ...(assignee ? { 'Assigned to': `@${assignee.login}` } : {}),
          },
        })
      )
      const chunks = []
      for (
        let startIndex = 0;
        startIndex < allIssues.length;
        startIndex += 10 // airtable max is 10 at a time
      ) {
        chunks.push(allIssues.slice(startIndex, startIndex + 10))
      }
      const results = await Promise.all(
        chunks.map((chunk) =>
          airtableBase(options.airtableTable).create(chunk, { typecast: true })
        )
      )
      return results.reduce((memo, chunkResult) => memo + chunkResult.length, 0)
    } catch (err) {
      log(
        chalk.red(`Could not import to Airtable base or table: ${err.message}`)
      )
    }
  }

  const githubSpinner = ora('Retrieving issues from Github').start()
  const issues = await fetchGithubIssues()
  githubSpinner.succeed(
    `Retrieved ${chalk.bold(issues.length)} issues from Github`
  )
  const airtableSpinner = ora('Importing issues into Airtable').start()
  const issuesImported = await importIssuesToAirtable(issues)
  airtableSpinner.succeed(
    `Imported ${chalk.bold(issuesImported)} issues into Airtable`
  )
}

function validateOptions(options) {
  let hasError = false
  if (!options.githubToken) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--github-token')} arg is required`))
  }

  if (!options.airtableApiKey) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--airtable-api-key')} arg is required`))
  }

  if (!options.airtableBase) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--airtable-base')} arg is required`))
  }

  if (!options.airtableTable) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--airtable-table')} arg is required`))
  }

  if (!options.githubUrl) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--github-url')} arg is required`))
  }

  if (!['open', 'closed', 'all'].includes(options.state.toLowerCase())) {
    hasError = true
    log(
      chalk.red(
        `Usage: ${chalk.bold('--state')} must be one of open | closed | all`
      )
    )
  }

  if (hasError) {
    log()
    process.exit(1)
  }
}

module.exports.default = githubAirtableImport
