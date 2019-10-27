import ejs = require('ejs')
import CaptainConstants = require('../../utils/CaptainConstants')
import Logger = require('../../utils/Logger')
import fs = require('fs-extra')
import uuid = require('uuid/v4')
import request = require('request')
import ApiStatusCodes = require('../../api/ApiStatusCodes')
import DockerApi from '../../docker/DockerApi'
import DataStore = require('../../datastore/DataStore')
import CertbotManager = require('./CertbotManager')
import { AnyError } from '../../models/OtherTypes'
import LoadBalancerInfo from '../../models/LoadBalancerInfo'
import * as path from 'path'
import Utils from '../../utils/Utils'

const defaultPageTemplate = fs
    .readFileSync(__dirname + '/../../../template/default-page.ejs')
    .toString()

const CONTAINER_PATH_OF_CONFIG = '/etc/nginx/conf.d'

const NGINX_CONTAINER_PATH_OF_FAKE_CERTS = '/etc/nginx/fake-certs'
const CAPROVER_CONTAINER_PATH_OF_FAKE_CERTS =
    __dirname + '/../../../template/fake-certs-src'
const HOST_PATH_OF_FAKE_CERTS =
    CaptainConstants.captainRootDirectoryGenerated +
    '/nginx/fake-certs-self-signed'

if (!fs.existsSync(CAPROVER_CONTAINER_PATH_OF_FAKE_CERTS))
    throw new Error('CAPROVER_CONTAINER_PATH_OF_FAKE_CERTS  is empty')
if (!defaultPageTemplate) throw new Error('defaultPageTemplate  is empty')

class LoadBalancerManager {
    private reloadInProcess: boolean
    private requestedReloadPromises: {
        dataStore: DataStore
        resolve: Function
        reject: Function
    }[]
    private captainPublicRandomKey: string

    constructor(
        private dockerApi: DockerApi,
        private certbotManager: CertbotManager,
        private dataStore: DataStore
    ) {
        this.reloadInProcess = false
        this.requestedReloadPromises = []
        this.captainPublicRandomKey = uuid()
    }

    /**
     * Reloads the configuation for NGINX.
     * NOTE that this can return synchronously with UNDEFINED if there is already a process in the background.
     * @param dataStoreToQueue
     * @returns {Promise.<>}
     */
    rePopulateNginxConfigFile(dataStoreToQueue: DataStore) {
        const self = this

        return new Promise<void>(function(res, rej) {
            self.requestedReloadPromises.push({
                dataStore: dataStoreToQueue,
                resolve: res,
                reject: rej,
            })
            self.consumeQueueIfAnyInNginxReloadQueue()
        })
    }

    consumeQueueIfAnyInNginxReloadQueue() {
        const self = this

        const q = self.requestedReloadPromises.pop()

        if (!q) {
            return
        }

        if (self.reloadInProcess) {
            Logger.d('NGINX Reload already in process, Bouncing off...')
            return
        }

        Logger.d('Locking NGINX configuration reloading...')

        self.reloadInProcess = true

        const dataStore = q.dataStore

        // This will resolve to something like: /captain/nginx/conf.d/captain
        const configFilePathBase =
            CaptainConstants.perAppNginxConfigPathBase +
            '/' +
            dataStore.getNameSpace()

        const FUTURE = configFilePathBase + '.fut'
        const BACKUP = configFilePathBase + '.bak'
        const CONFIG = configFilePathBase + '.conf'

        let nginxConfigContent = ''

        return Promise.resolve()
            .then(function() {
                return fs.remove(FUTURE)
            })
            .then(function() {
                return self.getServerList(dataStore)
            })
            .then(function(servers) {
                const promises: Promise<void>[] = []

                if (servers && !!servers.length) {
                    for (let i = 0; i < servers.length; i++) {
                        const s = servers[i]
                        if (s.hasSsl) {
                            s.crtPath = self.getSslCertPath(s.publicDomain)
                            s.keyPath = self.getSslKeyPath(s.publicDomain)
                        }

                        s.staticWebRoot =
                            CaptainConstants.nginxStaticRootDir +
                            CaptainConstants.nginxDomainSpecificHtmlDir +
                            '/' +
                            s.publicDomain

                        s.customErrorPagesDirectory =
                            CaptainConstants.nginxStaticRootDir +
                            CaptainConstants.nginxDefaultHtmlDir

                        const pathOfAuthInHost =
                            configFilePathBase + '-' + s.publicDomain + '.auth'

                        promises.push(
                            Promise.resolve()
                                .then(function() {
                                    if (s.httpBasicAuth) {
                                        s.httpBasicAuthPath = path.join(
                                            CONTAINER_PATH_OF_CONFIG,
                                            path.basename(pathOfAuthInHost)
                                        )
                                        return fs.outputFile(
                                            pathOfAuthInHost,
                                            s.httpBasicAuth
                                        )
                                    }
                                })
                                .then(function() {
                                    return ejs.render(s.nginxConfigTemplate, {
                                        s: s,
                                    })
                                })
                                .then(function(rendered) {
                                    nginxConfigContent += rendered
                                })
                        )
                    }
                }

                return Promise.all(promises)
            })
            .then(function() {
                return fs.outputFile(FUTURE, nginxConfigContent)
            })
            .then(function() {
                return fs.remove(BACKUP)
            })
            .then(function() {
                return fs.ensureFile(CONFIG)
            })
            .then(function() {
                return fs.renameSync(CONFIG, BACKUP) // sync method. It's really fast.
            })
            .then(function() {
                return fs.renameSync(FUTURE, CONFIG) // sync method. It's really fast.
            })
            .then(function() {
                return self.createRootConfFile(dataStore)
            })
            .then(function() {
                Logger.d('SUCCESS: UNLocking NGINX configuration reloading...')
                self.reloadInProcess = false
                q.resolve()
                self.consumeQueueIfAnyInNginxReloadQueue()
            })
            .catch(function(error: AnyError) {
                Logger.e(error)
                Logger.d('Error: UNLocking NGINX configuration reloading...')
                self.reloadInProcess = false
                q.reject(error)
                self.consumeQueueIfAnyInNginxReloadQueue()
            })
    }

    getServerList(dataStore: DataStore) {
        const self = this

        let hasRootSsl: boolean
        let rootDomain: string

        return Promise.resolve()
            .then(function() {
                return dataStore.getHasRootSsl()
            })
            .then(function(val: boolean) {
                hasRootSsl = val

                return dataStore.getRootDomain()
            })
            .then(function(val) {
                rootDomain = val
            })
            .then(function() {
                return dataStore.getDefaultAppNginxConfig()
            })
            .then(function(defaultAppNginxConfig) {
                return self.getAppsServerConfig(
                    dataStore,
                    defaultAppNginxConfig,
                    hasRootSsl,
                    rootDomain
                )
            })
    }

    getAppsServerConfig(
        dataStore: DataStore,
        defaultAppNginxConfig: string,
        hasRootSsl: boolean,
        rootDomain: string
    ) {
        const self = this

        const servers: IServerBlockDetails[] = []

        return dataStore
            .getAppsDataStore()
            .getAppDefinitions()
            .then(function(apps) {
                Object.keys(apps).forEach(function(appName) {
                    const webApp = apps[appName]
                    const httpBasicAuth =
                        webApp.httpAuth && webApp.httpAuth.passwordHashed //
                            ? webApp.httpAuth.user +
                              ':' +
                              webApp.httpAuth.passwordHashed
                            : ''

                    if (webApp.notExposeAsWebApp) {
                        return
                    }

                    const localDomain = dataStore
                        .getAppsDataStore()
                        .getServiceName(appName)
                    const forceSsl = !!webApp.forceSsl
                    const websocketSupport = !!webApp.websocketSupport
                    const nginxConfigTemplate =
                        webApp.customNginxConfig || defaultAppNginxConfig

                    const serverWithSubDomain = {} as IServerBlockDetails
                    serverWithSubDomain.hasSsl =
                        hasRootSsl && webApp.hasDefaultSubDomainSsl
                    serverWithSubDomain.publicDomain =
                        appName + '.' + rootDomain
                    serverWithSubDomain.localDomain = localDomain
                    serverWithSubDomain.forceSsl = forceSsl
                    serverWithSubDomain.websocketSupport = websocketSupport
                    const httpPort = webApp.containerHttpPort || 80
                    serverWithSubDomain.containerHttpPort = httpPort
                    serverWithSubDomain.nginxConfigTemplate = nginxConfigTemplate
                    serverWithSubDomain.httpBasicAuth = httpBasicAuth

                    servers.push(serverWithSubDomain)

                    // adding custom domains
                    const customDomainArray = webApp.customDomain
                    if (customDomainArray && customDomainArray.length > 0) {
                        for (
                            let idx = 0;
                            idx < customDomainArray.length;
                            idx++
                        ) {
                            const d = customDomainArray[idx]
                            servers.push({
                                containerHttpPort: httpPort,
                                hasSsl: d.hasSsl,
                                forceSsl: forceSsl,
                                websocketSupport: websocketSupport,
                                publicDomain: d.publicDomain,
                                localDomain: localDomain,
                                nginxConfigTemplate: nginxConfigTemplate,
                                staticWebRoot: '',
                                customErrorPagesDirectory: '',
                                httpBasicAuth: httpBasicAuth,
                            })
                        }
                    }
                })

                return servers
            })
    }

    sendReloadSignal() {
        return this.dockerApi.sendSingleContainerKillHUP(
            CaptainConstants.nginxServiceName
        )
    }

    getCaptainPublicRandomKey() {
        return this.captainPublicRandomKey
    }

    getSslCertPath(domainName: string) {
        const self = this
        return (
            CaptainConstants.letsEncryptEtcPathOnNginx +
            self.certbotManager.getCertRelativePathForDomain(domainName)
        )
    }

    getSslKeyPath(domainName: string) {
        const self = this
        return (
            CaptainConstants.letsEncryptEtcPathOnNginx +
            self.certbotManager.getKeyRelativePathForDomain(domainName)
        )
    }

    getInfo() {
        return new Promise<LoadBalancerInfo>(function(resolve, reject) {
            const url =
                'http://' + CaptainConstants.nginxServiceName + '/nginx_status'

            request(url, function(error, response, body) {
                if (error || !body) {
                    Logger.e('Error        ' + error)
                    reject(
                        ApiStatusCodes.createError(
                            ApiStatusCodes.STATUS_ERROR_GENERIC,
                            'Request to nginx Failed.'
                        )
                    )
                    return
                }

                try {
                    const data = new LoadBalancerInfo()
                    const lines = body.split('\n')

                    data.activeConnections = Number(
                        lines[0].split(' ')[2].trim()
                    )

                    data.accepted = Number(lines[2].split(' ')[1].trim())
                    data.handled = Number(lines[2].split(' ')[2].trim())
                    data.total = Number(lines[2].split(' ')[3].trim())

                    data.reading = Number(lines[3].split(' ')[1].trim())
                    data.writing = Number(lines[3].split(' ')[3].trim())
                    data.waiting = Number(lines[3].split(' ')[5].trim())

                    resolve(data)
                } catch (error) {
                    Logger.e(error)
                    reject(
                        ApiStatusCodes.createError(
                            ApiStatusCodes.STATUS_ERROR_GENERIC,
                            'Parser Failed. See internal logs...'
                        )
                    )
                }
            })
        })
    }

    createRootConfFile(dataStore: DataStore) {
        const self = this

        const captainDomain =
            CaptainConstants.captainSubDomain + '.' + dataStore.getRootDomain()
        const registryDomain =
            CaptainConstants.registrySubDomain + '.' + dataStore.getRootDomain()

        let hasRootSsl = false

        const FUTURE = CaptainConstants.rootNginxConfigPath + '.fut'
        const BACKUP = CaptainConstants.rootNginxConfigPath + '.bak'
        const CONFIG = CaptainConstants.rootNginxConfigPath + '.conf'

        let rootNginxTemplate: string | undefined = undefined

        return Promise.resolve()
            .then(function() {
                return dataStore.getNginxConfig()
            })
            .then(function(nginxConfig) {
                rootNginxTemplate =
                    nginxConfig.captainConfig.customValue ||
                    nginxConfig.captainConfig.byDefault

                return dataStore.getHasRootSsl()
            })
            .then(function(hasSsl) {
                hasRootSsl = hasSsl
                return dataStore.getHasRegistrySsl()
            })
            .then(function(hasRegistrySsl) {
                return ejs.render(rootNginxTemplate!, {
                    fake: {
                        crtPath: path.join(
                            NGINX_CONTAINER_PATH_OF_FAKE_CERTS,
                            'nginx.crt'
                        ),
                        keyPath: path.join(
                            NGINX_CONTAINER_PATH_OF_FAKE_CERTS,
                            'nginx.key'
                        ),
                    },
                    captain: {
                        crtPath: self.getSslCertPath(captainDomain),
                        keyPath: self.getSslKeyPath(captainDomain),
                        hasRootSsl: hasRootSsl,
                        serviceName: CaptainConstants.captainServiceName,
                        domain: captainDomain,
                        serviceExposedPort:
                            CaptainConstants.captainServiceExposedPort,
                        defaultHtmlDir:
                            CaptainConstants.nginxStaticRootDir +
                            CaptainConstants.nginxDefaultHtmlDir,
                        staticWebRoot:
                            CaptainConstants.nginxStaticRootDir +
                            CaptainConstants.nginxDomainSpecificHtmlDir +
                            '/' +
                            captainDomain,
                    },
                    registry: {
                        crtPath: self.getSslCertPath(registryDomain),
                        keyPath: self.getSslKeyPath(registryDomain),
                        hasRootSsl: hasRegistrySsl,
                        domain: registryDomain,
                        staticWebRoot:
                            CaptainConstants.nginxStaticRootDir +
                            CaptainConstants.nginxDomainSpecificHtmlDir +
                            '/' +
                            registryDomain,
                    },
                })
            })
            .then(function(rootNginxConfContent) {
                return fs.outputFile(FUTURE, rootNginxConfContent)
            })
            .then(function() {
                return fs.remove(BACKUP)
            })
            .then(function() {
                return fs.ensureFile(CONFIG)
            })
            .then(function() {
                return fs.renameSync(CONFIG, BACKUP) // sync method. It's really fast.
            })
            .then(function() {
                return fs.renameSync(FUTURE, CONFIG) // sync method. It's really fast.
            })
    }

    ensureBaseNginxConf() {
        const self = this
        return Promise.resolve()
            .then(function() {
                return self.dataStore.getNginxConfig()
            })
            .then(function(captainConfig) {
                const baseConfigTemplate =
                    captainConfig.baseConfig.customValue ||
                    captainConfig.baseConfig.byDefault

                return ejs.render(baseConfigTemplate, {})
            })
            .then(function(baseNginxConfFileContent) {
                return fs.outputFile(
                    CaptainConstants.baseNginxConfigPath,
                    baseNginxConfFileContent
                )
            })
    }

    init(myNodeId: string, dataStore: DataStore) {
        const dockerApi = this.dockerApi
        const self = this

        function createNginxServiceOnNode(nodeId: string) {
            Logger.d(
                'No Captain Nginx service is running. Creating one on captain node...'
            )

            return dockerApi
                .createServiceOnNodeId(
                    CaptainConstants.configs.nginxImageName,
                    CaptainConstants.nginxServiceName,
                    [
                        {
                            protocol: 'tcp',
                            publishMode: 'host',
                            containerPort: 80,
                            hostPort: CaptainConstants.nginxPortNumber,
                        },
                        {
                            protocol: 'tcp',
                            publishMode: 'host',
                            containerPort: 443,
                            hostPort: 443,
                        },
                    ],
                    nodeId,
                    undefined,
                    undefined,
                    {
                        Reservation: {
                            MemoryBytes: 30 * 1024 * 1024,
                        },
                    }
                )
                .then(function() {
                    const waitTimeInMillis = 5000
                    Logger.d(
                        'Waiting for ' +
                            waitTimeInMillis / 1000 +
                            ' seconds for nginx to start up'
                    )
                    return new Promise<boolean>(function(resolve, reject) {
                        setTimeout(function() {
                            resolve(true)
                        }, waitTimeInMillis)
                    })
                })
        }

        return fs
            .outputFile(
                CaptainConstants.captainStaticFilesDir +
                    CaptainConstants.nginxDefaultHtmlDir +
                    CaptainConstants.captainConfirmationPath,
                self.getCaptainPublicRandomKey()
            )
            .then(function() {
                return ejs.render(defaultPageTemplate, {
                    message_title: 'Nothing here yet :/',
                    message_body: '',
                    message_link: 'https://caprover.com/',
                    message_link_title: 'Read Docs',
                })
            })
            .then(function(staticPageContent) {
                return fs.outputFile(
                    CaptainConstants.captainStaticFilesDir +
                        CaptainConstants.nginxDefaultHtmlDir +
                        '/index.html',
                    staticPageContent
                )
            })
            .then(function() {
                return ejs.render(defaultPageTemplate, {
                    message_title: 'An Error Occurred :/',
                    message_body: '',
                    message_link: 'https://caprover.com/',
                    message_link_title: 'Read Docs',
                })
            })
            .then(function(errorGenericPageContent) {
                return fs.outputFile(
                    CaptainConstants.captainStaticFilesDir +
                        CaptainConstants.nginxDefaultHtmlDir +
                        '/error_generic_catch_all.html',
                    errorGenericPageContent
                )
            })
            .then(function() {
                return ejs.render(defaultPageTemplate, {
                    message_title: 'NGINX 502 Error :/',
                    message_body:
                        "If you are the developer, check your application's logs. See the link below for details",
                    message_link:
                        'https://caprover.com/docs/troubleshooting.html#successful-deploy-but-502-bad-gateway-error',
                    message_link_title: 'Docs - 502 Troubleshooting',
                })
            })
            .then(function(error502PageContent) {
                return fs.outputFile(
                    CaptainConstants.captainStaticFilesDir +
                        CaptainConstants.nginxDefaultHtmlDir +
                        '/captain_502_custom_error_page.html',
                    error502PageContent
                )
            })
            .then(function() {
                Logger.d('Copying fake certificates...')

                return fs.copy(
                    CAPROVER_CONTAINER_PATH_OF_FAKE_CERTS,
                    HOST_PATH_OF_FAKE_CERTS
                )
            })
            .then(function() {
                Logger.d('Setting up NGINX conf file...')

                return self.ensureBaseNginxConf()
            })
            .then(function() {
                return self.rePopulateNginxConfigFile(dataStore)
            })
            .then(function() {
                return fs.ensureDir(CaptainConstants.letsEncryptEtcPath)
            })
            .then(function() {
                return fs.ensureDir(CaptainConstants.nginxSharedPathOnHost)
            })
            .then(function() {
                return dockerApi.isServiceRunningByName(
                    CaptainConstants.nginxServiceName
                )
            })
            .then(function(isRunning) {
                if (isRunning) {
                    Logger.d('Captain Nginx is already running.. ')

                    return dockerApi.getNodeIdByServiceName(
                        CaptainConstants.nginxServiceName,
                        0
                    )
                } else {
                    return createNginxServiceOnNode(myNodeId).then(function() {
                        return myNodeId
                    })
                }
            })
            .then(function(nodeId) {
                if (nodeId !== myNodeId) {
                    Logger.d(
                        'Captain Nginx is running on a different node. Removing...'
                    )

                    return dockerApi
                        .removeServiceByName(CaptainConstants.nginxServiceName)
                        .then(function() {
                            return createNginxServiceOnNode(myNodeId).then(
                                function() {
                                    return true
                                }
                            )
                        })
                } else {
                    return true
                }
            })
            .then(function() {
                Logger.d('Updating NGINX service...')

                return dockerApi.updateService(
                    CaptainConstants.nginxServiceName,
                    CaptainConstants.configs.nginxImageName,
                    [
                        {
                            containerPath: CaptainConstants.nginxStaticRootDir,
                            hostPath: CaptainConstants.captainStaticFilesDir,
                        },
                        {
                            containerPath: NGINX_CONTAINER_PATH_OF_FAKE_CERTS,
                            hostPath: HOST_PATH_OF_FAKE_CERTS,
                        },
                        {
                            containerPath: '/etc/nginx/nginx.conf',
                            hostPath: CaptainConstants.baseNginxConfigPath,
                        },
                        {
                            containerPath: CONTAINER_PATH_OF_CONFIG,
                            hostPath:
                                CaptainConstants.perAppNginxConfigPathBase,
                        },
                        {
                            containerPath:
                                CaptainConstants.letsEncryptEtcPathOnNginx,
                            hostPath: CaptainConstants.letsEncryptEtcPath,
                        },
                        {
                            containerPath:
                                CaptainConstants.nginxSharedPathOnNginx,
                            hostPath: CaptainConstants.nginxSharedPathOnHost,
                        },
                    ],
                    [CaptainConstants.captainNetworkName],
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined
                )
            })
            .then(function() {
                const waitTimeInMillis = 5000
                Logger.d(
                    'Waiting for ' +
                        waitTimeInMillis / 1000 +
                        ' seconds for nginx reload to take into effect'
                )
                return new Promise<boolean>(function(resolve, reject) {
                    setTimeout(function() {
                        Logger.d('NGINX is fully set up and working...')
                        resolve(true)
                    }, waitTimeInMillis)
                })
            })
    }
}

export = LoadBalancerManager
