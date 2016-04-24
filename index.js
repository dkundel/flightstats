'use strict';

const FlightStats = require('./lib/flightstats');
const credentials = require('./google_credentials.json').installed;
const googleAuth = require('google-auth-library');
const inquirer = require('inquirer');
const Q = require('q');
const chalk = require('chalk');
const Spinner = require('cli-spinner').Spinner;
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const infoColor = chalk.cyan.bold;
const bold = chalk.bold;
const green = chalk.green;

let stats = new FlightStats();

function authorize() {
  let clientSecret = credentials.client_secret;
  let clientId = credentials.client_id;
  let redirectUrl = credentials.redirect_uris[0];
  let auth = new googleAuth();
  let oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl);

  let authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });

  console.log(`${infoColor('PLEASE AUTHORIZE AT:')} ${authUrl}`);
  return inquirer.prompt([
    { type: 'input', message: 'Authorized Code', name: 'code' }
  ]).then(answers => {
    let deferred = Q.defer();
    let spinner = new Spinner('Authorizing with Google API... %s');
    spinner.start();
    oauth2Client.getToken(answers.code, (err, token) => {
      spinner.stop(true);
      console.log('Authorizing with Google API... %s', chalk.green('DONE'));
      if (err) {
        console.error('Failed to authorize!');
        deferred.reject(err);
        return;
      }

      oauth2Client.credentials = token;
      deferred.resolve(oauth2Client);
    });
    return deferred.promise;
  });
}

authorize().then((auth) => {
  stats.getStats(auth);
});