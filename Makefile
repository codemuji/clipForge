.PHONY: setup lint test test\:unit test\:fixtures test\:gpu build dev clean eval\:detector

setup:
	node scripts/check-env.js
	npm install

lint:
	node scripts/lint.js

test:
	node scripts/test.js --all

test\:unit:
	node scripts/test.js --unit

test\:fixtures:
	node scripts/test.js --fixtures

test\:gpu:
	node scripts/test.js --gpu

build:
	node scripts/build.js

dev:
	node scripts/dev.js

clean:
	node scripts/clean.js

eval\:detector:
	node scripts/eval-detector.js
