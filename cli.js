#!/usr/bin/env node
const cmd = process.argv[2]

switch (cmd) {
  case 'setup':
    require('./setup')
    break
  case 'start':
  case 'launch':
  case undefined:
    require('./launcher')
    break
  case 'agent':
    require('./agent')
    break
  case 'help':
  default:
    console.log(`
  SocialFlow Agent - CLI

  Usage:
    socialflow setup    Setup wizard (first time)
    socialflow start    Start agent + open dashboard
    socialflow agent    Start agent only (no browser)
    socialflow help     Show this help
`)
}
