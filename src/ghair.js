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
  const airtable = new Airtable({ apiKey: options.airtableApiKey })
  const airtableTable = airtable.base(options.airtableBase)(
    options.airtableTable
  )

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

  function fieldsFromIssue({
    created_at,
    updated_at,
    title,
    body,
    html_url,
    number,
    labels,
    assignee,
    state,
  }) {
    return {
      'Created At': created_at,
      'Updated At': updated_at,
      'Issue Number': number,
      Name: title,
      Description: body,
      'Github URL': html_url,
      Labels: labels.map((l) => l.name).join(','),
      Status: state,
      ...(assignee ? { 'Assigned to': `@${assignee.login}` } : {}),
    }
  }

  async function getExistingAirtableIssueRows() {
    const allRecords = []
    await airtableTable.select().eachPage((records, fetchNextPage) => {
      allRecords.push(...records)
      fetchNextPage()
    })
    return allRecords
  }

  async function importIssuesToAirtable(issues, existingRows) {
    const issueNumbersToExistingRows = Object.fromEntries(
      existingRows.map((row) => [row.fields['Issue Number'], row])
    )

    try {
      async function insertNewRows(newIssues) {
        const newRows = newIssues.map((issue) => ({
          fields: fieldsFromIssue(issue),
        }))
        const chunks = []
        for (
          let startIndex = 0;
          startIndex < newRows.length;
          startIndex += 10 // airtable max is 10 at a time
        ) {
          chunks.push(newRows.slice(startIndex, startIndex + 10))
        }
        const results = await Promise.all(
          chunks.map((chunk) => airtableTable.create(chunk, { typecast: true }))
        )
        return results.reduce(
          (memo, chunkResult) => memo + chunkResult.length,
          0
        )
      }

      async function updateExistingRows(existingIssues) {
        const rowsToUpdate = existingIssues
          .filter((issue) => {
            // don't compare timestamps
            const {
              'Created At': _,
              'Updated At': _2,
              ...fields
            } = fieldsFromIssue(issue)
            const existingRow = issueNumbersToExistingRows[issue.number]

            // array comparison is different
            for (const key in fields) {
              if (existingRow.fields[key] instanceof Array) {
                const existingArrValues = existingRow.fields[key].filter(
                  (v) => !!v
                )
                if (existingArrValues.length > 0 && !fields[key]) {
                  return true
                }
                const newArrValues = fields[key].split(',').filter((v) => !!v)
                if (existingArrValues.length !== newArrValues.length) {
                  return true
                }
                const existingValues = new Set(existingArrValues)
                for (const value of newArrValues) {
                  if (!existingValues.has(value)) {
                    return true
                  }
                }
                return false
              }

              if (
                (existingRow.fields[key] || undefined) !==
                (fields[key] || undefined)
              ) {
                return true
              }
            }
            return false
          })
          .map((issue) => ({
            id: issueNumbersToExistingRows[issue.number].id,
            fields: fieldsFromIssue(issue),
          }))

        const chunks = []
        for (
          let startIndex = 0;
          startIndex < rowsToUpdate.length;
          startIndex += 10 // airtable max is 10 at a time
        ) {
          chunks.push(rowsToUpdate.slice(startIndex, startIndex + 10))
        }
        const results = await Promise.all(
          chunks.map((chunk) => airtableTable.update(chunk, { typecast: true }))
        )
        return results.reduce(
          (memo, chunkResult) => memo + chunkResult.length,
          0
        )
      }

      const [numNewRows, numUpdatedRows] = await Promise.all([
        insertNewRows(
          issues.filter((i) => !issueNumbersToExistingRows[i.number])
        ),
        updateExistingRows(
          issues.filter((i) => issueNumbersToExistingRows[i.number])
        ),
      ])
      return { numNewRows, numUpdatedRows }
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
  const airtableGetSpinner = ora(
    'Getting existing issues from Airtable'
  ).start()
  const existingRows = await getExistingAirtableIssueRows()
  airtableGetSpinner.succeed(
    `Retrieved ${chalk.bold(existingRows.length)} issues from Airtable`
  )

  const airtableSaveSpinner = ora('Importing issues into Airtable').start()
  const { numNewRows, numUpdatedRows } = await importIssuesToAirtable(
    issues,
    existingRows
  )
  airtableSaveSpinner.succeed(
    `Imported ${chalk.bold(
      numNewRows
    )} issues into Airtable, and updated ${numUpdatedRows} existing rows`
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
