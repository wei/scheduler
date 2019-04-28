const Bottleneck = require('bottleneck')

const limiter = new Bottleneck({ maxConcurrent: 5, minTime: 0 })
const ignoredAccounts = (process.env.IGNORED_ACCOUNTS || '')
  .toLowerCase()
  .split(',')

const defaults = {
  delay: !process.env.DISABLE_DELAY, // Should the first run be put on a random delay?
  interval: 60 * 60 * 1000 // 1 hour
}

module.exports = (app, options) => {
  options = Object.assign({}, defaults, options || {})
  const intervals = {}
  const REPO_STATUS = {}
  const INSTALLATIONS = {}
  const REPOSITORIES = {}
  const REPO_TO_INSTALLATION = {}
  const REPO_NAME_TO_ID = {}

  // https://developer.github.com/v3/activity/events/types/#installationrepositoriesevent
  app.on('installation.created', async event => {
    const installation = event.payload.installation
    INSTALLATIONS[installation.id] = installation

    eachRepository(installation, repository => {
      REPO_TO_INSTALLATION[repository.id] = installation.id
      schedule(repository)
    })
  })

  // https://developer.github.com/v3/activity/events/types/#installationrepositoriesevent
  app.on('installation_repositories.added', async event => {
    return setupInstallation(event.payload.installation)
  })

  setup()

  function setup () {
    return eachInstallation(setupInstallation)
  }

  function setupInstallation (installation) {
    if (ignoredAccounts.includes(installation.account.login.toLowerCase())) {
      app.log.info({ installation }, 'Installation is ignored')
      return
    }

    limiter.schedule(eachRepository, installation, repository => {
      REPO_TO_INSTALLATION[repository.id] = installation.id
      schedule(repository)
    })
  }

  function schedule (repository) {
    if (intervals[repository.id]) {
      return
    }

    // Wait a random delay to more evenly distribute requests
    const delay = options.delay ? options.interval * Math.random() : 0

    app.log.debug({ repository, delay, interval: options.interval }, `Scheduling interval`)

    intervals[repository.id] = setTimeout(triggerEvent.bind(null, repository.id), delay)
    REPO_STATUS[repository.full_name] = 'ADDED'
  }

  function triggerEvent (repoId, opts = {}) {
    const repository = REPOSITORIES[repoId]
    if (!repository) return
    REPO_STATUS[repository.full_name] = new Date()
    const event = {
      name: 'schedule',
      payload: { 
        action: 'repository', 
        manual: !!opts.manual,
        installation: INSTALLATIONS[REPO_TO_INSTALLATION[repoId]], 
        repository 
      }
    }
    app.receive(event)
    if (!opts.manual) {
      intervals[repoId] = setTimeout(triggerEvent.bind(null, repoId), options.interval)
    }
  }

  async function eachInstallation (callback) {
    app.log.trace('Fetching installations')
    const github = await app.auth()

    const installations = await github.paginate(
      github.apps.listInstallations.endpoint.merge({ per_page: 100 })
    )

    const filteredInstallations = options.filter
      ? installations.filter(inst => options.filter(inst))
      : installations

    for (const i of filteredInstallations) {
      INSTALLATIONS[i.id] = i
    }

    return filteredInstallations.forEach(callback)
  }

  async function eachRepository (installation, callback) {
    app.log.trace({ installation }, 'Fetching repositories for installation')
    const github = await app.auth(installation.id)

    const repositories = await github.paginate(
      github.apps.listRepos.endpoint.merge({ per_page: 100 }),
      response => {
        return response.data
      }
    )

    const filteredRepositories = options.filter
      ? repositories.filter(repo => options.filter(installation, repo))
      : repositories

    for (const r of filteredRepositories) {
      REPOSITORIES[r.id] = r
      REPO_NAME_TO_ID[r.full_name] = r.id
      REPO_TO_INSTALLATION[r.id] = installation.id
    }

    return filteredRepositories.forEach(async repository =>
      callback(repository, github)
    )
  }

  function process (repoName) {
    app.log.info({ repository: repoName }, `Manuel processing`)

    triggerEvent(REPO_NAME_TO_ID[repoName], { manual: true })
  }

  function stop (repository) {
    app.log.info({ repository }, `Canceling interval`)

    clearInterval(intervals[repository.id])
    REPO_STATUS[repository.full_name] = 'STOPPED'
  }

  return { REPOSITORIES, INSTALLATIONS, repos: REPO_STATUS, process, stop }
}
