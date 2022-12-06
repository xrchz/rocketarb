#!/usr/bin/env bash

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
RP_PROJECT_NAME=${RP_PROJECT_NAME:-rocketpool}

set -e

if ! command -v docker &>/dev/null; then
	echo "error: could not find docker. Please install it before continuing"
	exit 1
fi

# Force image build?
if [ "$1" = "--build" ]; then
	docker build -t rocketarb "${SCRIPT_DIR}/.."
	exit $?
fi

# Ensure that the docker image is built
if ! docker image inspect rocketarb &>/dev/null; then
	docker build -t rocketarb "${SCRIPT_DIR}/.."
fi

# Try to detect Rocket Pool's EC container. If found, attach to its network namespace.
if docker container inspect ${RP_PROJECT_NAME}_eth1 &>/dev/null; then
	DOCKER_NETWORK="container:${RP_PROJECT_NAME}_eth1"
else
	DOCKER_NETWORK="host"
fi

# We will drop all privileges and run as our user.
# Add supplementary groups so we can reach the Docker socket.
SUPP_GROUPS=""
for group in $(id -G); do
	SUPP_GROUPS="${SUPP_GROUPS} --group-add ${group} "
done

docker run --rm -ti \
	--user "$(id -u):$(id -g)" \
	${SUPP_GROUPS} \
	--security-opt no-new-privileges \
	--cap-drop ALL \
	-v /var/run/docker.sock:/var/run/docker.sock \
	-v $(pwd):/work \
	--net ${DOCKER_NETWORK} \
	rocketarb "$@"
