const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async function hardenPackagedNerion(context) {
  if (context.electronPlatformName !== 'darwin') return

  const plistPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  )

  // electron-builder deliberately enables arbitrary HTTP while configuring
  // localhost ATS exceptions. Nerion only needs plain HTTP for local Ollama.
  execFileSync('/usr/bin/plutil', [
    '-replace',
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    '-bool',
    'NO',
    plistPath,
  ])

  const value = execFileSync('/usr/bin/plutil', [
    '-extract',
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    'raw',
    plistPath,
  ], { encoding: 'utf8' }).trim()
  if (value !== 'false') throw new Error('Packaged Nerion still allows arbitrary insecure network loads.')
}
