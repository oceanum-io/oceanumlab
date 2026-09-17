# oceanumlab

[![Github Actions Status](https://github.com/oceanum-io/oceanumlab/workflows/Build/badge.svg)](https://github.com/oceanum-io/oceanumlab/actions/workflows/build.yml)
A Jupyterlab extension to interact with the Oceanum.io platform

This extension is composed of a Python package named `oceanumlab`
for the server extension and a NPM package named `oceanumlab`
for the frontend extension.

## Requirements

- JupyterLab >= 4.0

## Install

To install the extension, execute:

```bash
pip install oceanumlab
```

## Oceanum.io sign-in

A **Sign in to Oceanum.io** control sits in the top bar. Signing in gives the Notebooks tab
your stored notebooks and lets Oceanum AI act as you, with no Datamesh token to paste.

It uses the OAuth **device grant**, run by oceanumlab's Jupyter server extension: click
**Sign in**, open the link it shows, check the code matches, and sign in on Oceanum.io as
usual. The dialog closes by itself when you are done. It works with no configuration, and
from any address — `localhost` on any port, a JupyterHub, a remote server.

That last point is why it works this way. A browser sign-in (a popup, a redirect, the
Oceanum widget) has to tell Auth0 which page to return to, Auth0 only accepts addresses
registered in advance, and it cannot wildcard a port or an arbitrary host. A JupyterLab's
address is not knowable ahead of time, so on anything but Oceanum's own sites a browser
sign-in fails with "Callback URL mismatch". The device grant has no callback.

The refresh token stays in the Jupyter server's memory and never reaches the page or the
disk, so restarting the server signs you out.

### Configuration

Sign-in is server configuration, not a frontend setting: which Auth0 tenant a notebook signs
in to, and which services its tokens are sent to, is the deployment's decision, and a
user-editable setting could be pointed at someone else's. In `jupyter_server_config.py` —
`~/.jupyter/` for one user, or `etc/jupyter/` under the environment prefix for everyone
using it; `jupyter --paths` lists both:

```python
c.OceanumLab.sign_in = "off"        # "device" is the default
```

To sign in to a deployment other than Oceanum production, replace the environment whole:

```python
c.OceanumLab.device_environment = {
    "auth0Domain": "auth.example.org",
    "clientId": "<an Auth0 Native application with the Device Code grant>",
    "audience": "",
    "oceanumDomain": "example.org",
    "urls": {
        "datamesh": "https://datamesh.example.org",
        "specs": "https://specs.example.org",
        "manage": "https://manage.example.org",
    },
}
```

**This file is Python, not JSON** — `True`, not `true`. A syntax error there is quiet and
expensive: traitlets logs it once at startup and then skips the **whole** file, so the
setting silently does not apply. Check the server's startup log for
`oceanumlab: Oceanum.io sign-in by device code`.

notebook.oceanum.io is a JupyterLite site with no Jupyter server, so none of this applies
there. It signs in with the Oceanum widget, from its own extension, and lists
`@oceanum/oceanumlab:device-auth` under `disabledExtensions`.

## Uninstall

To remove the extension, execute:

```bash
pip uninstall oceanumlab
```

## Contributing

### Development install

The extension is built with [jupyter-builder](https://github.com/jupyterlab/jupyter-builder),
which bundles it with rspack. You will need:

- Python 3.10 or later
- Node.js 22.12 or later (or 20.19+), which rspack requires

The `jlpm` command is a pinned version of [yarn](https://yarnpkg.com/) that is
installed with jupyter-builder. You may use `yarn` or `npm` in lieu of `jlpm` below.

Create an environment, either with conda, which also installs Node.js and jupyter-builder:

```bash
# Clone the repo to your local environment
# Change directory to the oceanumlab directory
conda env create -f environment.yml
conda activate oceanumlab
```

or with a virtual environment, using your own Node.js:

```bash
python -m venv .venv
source .venv/bin/activate
```

Then install the extension in development mode:

```bash
# Install the package in development mode. The dev extra installs jupyter-builder
# and the test extra installs the server test dependencies. This also enables the
# server extension.
pip install -e ".[dev,test]"
# Link your development version of the extension with JupyterLab
jupyter-builder develop . --overwrite
# Rebuild the extension after making changes
# Unlike the steps above, which you only do once, do this every time you make a change
jlpm build
```

Every `pip install -e` puts a copy of the built extension back in place of the link,
so run `jupyter-builder develop . --overwrite` again after reinstalling.

The main build commands are:

- `jlpm build`: development build, with source maps
- `jlpm build:prod`: production build, as used for releases
- `jlpm clean:all`: remove the built TypeScript, the built extension and the lint caches

You can watch the source directory and run JupyterLab at the same time in different terminals to watch for changes in the extension's source and automatically rebuild the extension.

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
# (runs tsc and jupyter-builder in watch mode)
jlpm watch
# Run JupyterLab in another terminal
jupyter lab
```

With the watch command running, every saved change will immediately be built locally and available in your running JupyterLab. Refresh JupyterLab to load the change in your browser (you may need to wait several seconds for the extension to be rebuilt).

By default, the `jlpm build` command generates the source maps for this extension to make it easier to debug using the browser dev tools. To also generate source maps for the JupyterLab core extensions, you can run the following command:

```bash
jupyter lab build --minimize=False
```

### Development uninstall

```bash
pip uninstall oceanumlab
```

In development mode, you will also need to remove the symlink created by the `jupyter-builder develop`
command. To find its location, you can run `jupyter labextension list` to figure out where the `labextensions`
folder is located. Then you can remove the symlink named `@oceanum/oceanumlab` within that folder.

### Testing the extension

#### Server tests

This extension is using [Pytest](https://docs.pytest.org/) for Python code testing.

The test dependencies are installed by `pip install -e ".[dev,test]"` above. If you
installed without the test extra, install them (needed only once) and restore the
front-end extension link:

```sh
pip install -e ".[dev,test]"
jupyter-builder develop . --overwrite
```

To execute them, run:

```sh
pytest -vv -r ap --cov oceanumlab
```

#### Frontend tests

This extension is using [Jest](https://jestjs.io/) for JavaScript code testing.

To execute them, execute:

```sh
jlpm
jlpm test
```

#### Integration tests

This extension uses [Playwright](https://playwright.dev/docs/intro) for the integration tests (aka user level tests).
More precisely, the JupyterLab helper [Galata](https://github.com/jupyterlab/jupyterlab/tree/master/galata) is used to handle testing the extension in JupyterLab.

More information are provided within the [ui-tests](./ui-tests/README.md) README.

### Packaging the extension

See [RELEASE](RELEASE.md)
